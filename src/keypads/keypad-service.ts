import { EventEmitter } from 'node:events';
import { createLogger } from '../config/logger.js';
import type { ConnectivityStatus } from '../db/repositories/sensor-repository.js';
import {
  toPublicInput,
  type KeypadAdapter,
  type KeypadCapability,
  type KeypadIndication,
  type KeypadInput,
  type PublicKeypadInput,
  type RawNotification,
  type ValueWrite,
} from './keypad.js';

const logger = createLogger('keypads/service');

/** Sends value writes to a node. The Z-Wave gateway provides the real one; tests provide a stub. */
export type KeypadValueWriter = (nodeId: number, writes: ValueWrite[]) => Promise<void>;

/** The `KeypadSummary` of contracts: what clients see of a keypad. */
export interface KeypadSummary {
  nodeId: number;
  adapterId: string;
  label: string;
  capabilities: readonly KeypadCapability[];
  chimeSounds: readonly string[];
  connectivityStatus: ConnectivityStatus;
  batteryLevel: number | null;
}

/** Emitted as `'keypad_input'`. Carries the entered code, so only the keypad controller may listen. */
export interface KeypadInputEvent {
  nodeId: number;
  adapterId: string;
  input: KeypadInput;
}

/** Emitted as `'keypad_event'`. Safe to push to clients: the entered code is removed. */
export interface KeypadPublicEvent {
  nodeId: number;
  adapterId: string;
  input: PublicKeypadInput;
}

export class KeypadNotFoundError extends Error {}
/** The keypad exists but cannot do what was asked (no such chime sound, no chime capability). */
export class KeypadUnsupportedError extends Error {}

interface KeypadEntry {
  adapter: KeypadAdapter;
  connectivityStatus: ConnectivityStatus;
  batteryLevel: number | null;
}

/**
 * The keypads currently on the Z-Wave network, and the one place that talks to them in generic
 * terms: it decodes their input and renders indications through each keypad's own adapter, so
 * callers never see a device-specific type.
 *
 * Emits `'keypad_changed'` (KeypadSummary) when a keypad appears or its connectivity/battery
 * changes, `'keypad_event'` (KeypadPublicEvent) for every decoded input, and `'keypad_input'`
 * (KeypadInputEvent, code included) for the controller.
 */
export class KeypadService extends EventEmitter {
  private readonly keypads = new Map<number, KeypadEntry>();

  constructor(private readonly writeValues: KeypadValueWriter) {
    super();
  }

  /** Starts tracking a node as a keypad. A repeat call for a known node leaves its state alone. */
  add(nodeId: number, adapter: KeypadAdapter, initial: Partial<Pick<KeypadEntry, 'connectivityStatus' | 'batteryLevel'>> = {}): KeypadSummary {
    const existing = this.keypads.get(nodeId);
    if (existing) {
      return this.summarize(nodeId, existing);
    }
    const entry: KeypadEntry = {
      adapter,
      connectivityStatus: initial.connectivityStatus ?? 'online',
      batteryLevel: initial.batteryLevel ?? null,
    };
    this.keypads.set(nodeId, entry);
    const summary = this.summarize(nodeId, entry);
    this.emit('keypad_changed', summary);
    return summary;
  }

  has(nodeId: number): boolean {
    return this.keypads.has(nodeId);
  }

  list(): KeypadSummary[] {
    return [...this.keypads].map(([nodeId, entry]) => this.summarize(nodeId, entry));
  }

  updateStatus(nodeId: number, changes: Partial<Pick<KeypadEntry, 'connectivityStatus' | 'batteryLevel'>>): void {
    const entry = this.keypads.get(nodeId);
    if (!entry) {
      return;
    }
    const nextConnectivity = changes.connectivityStatus ?? entry.connectivityStatus;
    const nextBattery = changes.batteryLevel === undefined ? entry.batteryLevel : changes.batteryLevel;
    if (nextConnectivity === entry.connectivityStatus && nextBattery === entry.batteryLevel) {
      return;
    }
    entry.connectivityStatus = nextConnectivity;
    entry.batteryLevel = nextBattery;
    this.emit('keypad_changed', this.summarize(nodeId, entry));
  }

  /** Decodes a node notification with the keypad's adapter and publishes any input it contains. */
  receive(nodeId: number, notification: RawNotification): void {
    const entry = this.keypads.get(nodeId);
    if (!entry) {
      return;
    }
    const input = entry.adapter.decodeInput(notification);
    if (!input) {
      return;
    }
    const base = { nodeId, adapterId: entry.adapter.id };
    this.emit('keypad_event', { ...base, input: toPublicInput(input) } satisfies KeypadPublicEvent);
    this.emit('keypad_input', { ...base, input } satisfies KeypadInputEvent);
  }

  /** Renders an indication on one keypad. Failures are logged, never thrown: a keypad is cosmetic to the alarm. */
  async indicate(nodeId: number, indication: KeypadIndication): Promise<void> {
    const entry = this.keypads.get(nodeId);
    if (!entry) {
      return;
    }
    const writes = entry.adapter.encodeIndication(indication);
    if (writes.length === 0) {
      return;
    }
    try {
      await this.writeValues(nodeId, writes);
    } catch (err) {
      logger.error('failed to update keypad', {
        nodeId,
        indication: indication.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Renders an indication on every keypad that supports `indicators`. */
  async indicateAll(indication: KeypadIndication): Promise<void> {
    const targets = [...this.keypads]
      .filter(([, entry]) => entry.adapter.capabilities.includes('indicators'))
      .map(([nodeId]) => nodeId);
    await Promise.all(targets.map((nodeId) => this.indicate(nodeId, indication)));
  }

  /** Plays a chime on one keypad. Throws `KeypadNotFoundError`/`KeypadUnsupportedError` for a bad request. */
  async chime(nodeId: number, sound: string, volume?: number): Promise<void> {
    const entry = this.keypads.get(nodeId);
    if (!entry) {
      throw new KeypadNotFoundError(`No keypad with node id ${String(nodeId)}`);
    }
    if (!entry.adapter.capabilities.includes('chime')) {
      throw new KeypadUnsupportedError(`${entry.adapter.label} cannot play chimes`);
    }
    if (!entry.adapter.chimeSounds.includes(sound)) {
      throw new KeypadUnsupportedError(
        `Unknown chime sound "${sound}"; expected one of: ${entry.adapter.chimeSounds.join(', ')}`,
      );
    }
    const writes = entry.adapter.encodeIndication({ kind: 'chime', sound, ...(volume !== undefined && { volume }) });
    await this.writeValues(nodeId, writes);
  }

  private summarize(nodeId: number, entry: KeypadEntry): KeypadSummary {
    return {
      nodeId,
      adapterId: entry.adapter.id,
      label: entry.adapter.label,
      capabilities: entry.adapter.capabilities,
      chimeSounds: entry.adapter.chimeSounds,
      connectivityStatus: entry.connectivityStatus,
      batteryLevel: entry.batteryLevel,
    };
  }
}
