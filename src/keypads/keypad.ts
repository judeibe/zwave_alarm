/**
 * The keypad domain: what any Z-Wave alarm keypad can do, with no knowledge of a particular
 * device or of zwave-js. A device-specific adapter (src/keypads/adapters) translates between this
 * vocabulary and the device's own command classes; everything else depends only on these types.
 */

export type KeypadCapability = 'arm_disarm' | 'emergency' | 'indicators' | 'chime';

export type EmergencyKind = 'fire' | 'police' | 'medical';

/** A button press (or entered code) reported by a keypad. */
export type KeypadInput =
  | { kind: 'code_entered'; code: string }
  | { kind: 'arm_away'; code?: string }
  | { kind: 'arm_home'; code?: string }
  | { kind: 'disarm'; code?: string }
  | { kind: 'cancel' }
  | { kind: 'emergency'; emergency: EmergencyKind };

/** `KeypadInput` with any entered code removed: the form that is safe to log or push to clients. */
export type PublicKeypadInput =
  | { kind: 'code_entered' | 'arm_away' | 'arm_home' | 'disarm' | 'cancel' }
  | { kind: 'emergency'; emergency: EmergencyKind };

export function toPublicInput(input: KeypadInput): PublicKeypadInput {
  return input.kind === 'emergency' ? { kind: 'emergency', emergency: input.emergency } : { kind: input.kind };
}

/** Something the panel wants a keypad to show or play. An adapter ignores kinds its device can't render. */
export type KeypadIndication =
  | { kind: 'mode'; mode: 'disarmed' | 'armed_home' | 'armed_away' }
  | { kind: 'alarm' }
  | { kind: 'entry_delay'; seconds: number }
  | { kind: 'exit_delay'; seconds: number }
  | { kind: 'code_rejected' }
  | { kind: 'bypass_required' }
  | { kind: 'chime'; sound: string; volume?: number };

/** The identity a Z-Wave node reports, which is how an adapter recognises its device. */
export interface NodeIdentity {
  manufacturerId: number;
  productType: number;
  productId: number;
}

/** A notification as zwave-js delivers it from a node, reduced to plain data. */
export interface RawNotification {
  commandClass: number;
  args: Record<string, unknown>;
}

/** One value to write to a node, as the gateway will hand it to `node.setValue`. */
export interface ValueWrite {
  commandClass: number;
  endpoint: number;
  property: string | number;
  propertyKey?: string | number;
  value: number | boolean;
}

/**
 * The port a device-specific keypad implements. Adapters are pure: they decode and encode, and
 * never touch the driver, the panel or the database, so each one is unit-testable on its own.
 */
export interface KeypadAdapter {
  /** Stable identifier, unique across adapters; surfaced on the API as `adapterId`. */
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly KeypadCapability[];
  /** Sound ids accepted by `{ kind: 'chime' }`; empty when the keypad has no `chime` capability. */
  readonly chimeSounds: readonly string[];

  supports(identity: NodeIdentity): boolean;
  /** Returns null for a notification that is not a user input (caching, unknown event types). */
  decodeInput(notification: RawNotification): KeypadInput | null;
  /** Returns no writes for an indication the device can't render. */
  encodeIndication(indication: KeypadIndication): ValueWrite[];
}
