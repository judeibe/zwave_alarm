import { EventEmitter } from 'node:events';
import { createLogger } from '../config/logger.js';
import { isExpired, type UserRepository } from '../auth/user-repository.js';
import type { AlarmPanel } from '../alarm/panel-repository.js';
import type { PanelService } from '../alarm/panel-service.js';
import type { EventRepository } from '../events/event-repository.js';
import type { LockCodeSlotRepository } from './lock-code-slots.js';
import type { LockModeKey, LockModeSettingsRepository } from './lock-mode-settings.js';
import type { LockAccess, LockService, LockSummary } from './lock-service.js';

const logger = createLogger('locks/automation');

/** What `'lock_event'` carries, and the WebSocket `lock.event` message mirrors. */
export interface LockEvent {
  nodeId: number;
  kind: 'locked' | 'unlocked' | 'armed' | 'disarmed' | 'jammed';
  /** The app user behind the keypad code, when it is one of ours. */
  userId: string | null;
  method: LockAccess['method'];
}

interface LockAccessEvent extends LockAccess {
  nodeId: number;
  label: string;
}

const MODE_KEYS: Partial<Record<AlarmPanel['mode'], LockModeKey>> = {
  disarmed: 'disarmed',
  armed_home: 'armed_home',
  armed_away: 'armed_away',
};

const METHOD_TEXT: Record<LockAccess['method'], string> = {
  keypad: 'with a keypad code',
  one_touch: 'with the one-touch button',
  manual: 'by hand',
  app: 'from the app',
  auto: 'by auto-lock',
  unknown: '',
};

/**
 * Connects the locks to the alarm (Ring spec, Locks). From a lock's own notifications it
 *  - writes the history (`lock_locked`, `lock_unlocked`, `lock_jammed`, `lock_offline`, `lock_online`),
 *  - arms AWAY when the lock is locked with an app-created code or its one-touch button, and disarms when it
 *    is unlocked with an app-created code, if that lock's settings say so, and
 *  - locks or unlocks locks when the panel enters a mode, per their settings.
 * Only codes in the slot map (created in the app) can arm or disarm; codes programmed on the lock itself never
 * do. A mode change that a lock itself caused does not command any lock ("only the lock used changes state").
 * Emits `'lock_event'` (LockEvent) for the WebSocket stream.
 */
export class LockAutomation extends EventEmitter {
  private lastMode: AlarmPanel['mode'];
  /** The mode a lock-driven change is heading to; entering it commands no lock. */
  private skipEntryOf: LockModeKey | null = null;
  private readonly connectivity = new Map<number, LockSummary['connectivityStatus']>();

  constructor(
    private readonly locks: LockService,
    private readonly panelService: PanelService,
    private readonly userRepo: UserRepository,
    private readonly eventRepo: EventRepository,
    private readonly settings: LockModeSettingsRepository,
    private readonly slots: LockCodeSlotRepository,
  ) {
    super();
    this.lastMode = panelService.getState().mode;
  }

  start(): void {
    this.locks.on('lock_access', (access: LockAccessEvent) => void this.handleAccess(access));
    this.locks.on('lock_changed', (summary: LockSummary) => this.handleConnectivity(summary));
    this.locks.on('lock_removed', (nodeId: number) => {
      // An unenrolled lock was cleared, so none of our codes are on it any more.
      this.slots.deleteForNode(nodeId);
      this.settings.delete(nodeId);
      this.connectivity.delete(nodeId);
    });
    this.panelService.on('panel_changed', (panel: AlarmPanel) => void this.handlePanel(panel));
  }

  private device(nodeId: number, label: string): { id: string; name: string } {
    return { id: `node-${String(nodeId)}`, name: label };
  }

  private handleConnectivity(summary: LockSummary): void {
    const previous = this.connectivity.get(summary.nodeId);
    this.connectivity.set(summary.nodeId, summary.connectivityStatus);
    if (previous === undefined || previous === summary.connectivityStatus) {
      return;
    }
    const device = this.device(summary.nodeId, summary.label);
    this.eventRepo.record({
      type: summary.connectivityStatus === 'offline' ? 'lock_offline' : 'lock_online',
      source: 'system',
      deviceId: device.id,
      deviceName: device.name,
      details: summary.connectivityStatus === 'offline' ? 'The lock stopped responding' : 'The lock is responding again',
    });
  }

  private async handleAccess(access: LockAccessEvent): Promise<void> {
    const device = this.device(access.nodeId, access.label);
    const userId = access.slot === null ? null : (this.slots.findUserBySlot(access.nodeId, access.slot) ?? null);
    const user = userId === null ? undefined : this.userRepo.findById(userId);
    const how = METHOD_TEXT[access.method];
    const who = user ? ` (${user.name})` : access.method === 'keypad' && access.slot !== null ? ` (slot ${String(access.slot)})` : '';

    if (access.kind === 'jammed') {
      this.eventRepo.record({ type: 'lock_jammed', source: 'system', deviceId: device.id, deviceName: device.name, details: 'The bolt jammed' });
    } else {
      this.eventRepo.record({
        type: access.kind === 'locked' ? 'lock_locked' : 'lock_unlocked',
        source: user ? 'user' : 'system',
        sourceUserId: user?.id ?? null,
        actor: user?.name ?? (access.method === 'one_touch' ? 'One-touch' : null),
        deviceId: device.id,
        deviceName: device.name,
        details: `${access.kind === 'locked' ? 'Locked' : 'Unlocked'} ${how}${who}`.replace(/\s+/g, ' ').trim(),
      });
    }
    this.emit('lock_event', { nodeId: access.nodeId, kind: access.kind, userId, method: access.method } satisfies LockEvent);

    try {
      await this.driveAlarm(access, user, device);
    } catch (err) {
      logger.warn('lock-driven arm/disarm did not go through', {
        nodeId: access.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Arms or disarms the panel for a lock operation, if the lock's settings and the code allow it. */
  private async driveAlarm(
    access: LockAccessEvent,
    user: ReturnType<UserRepository['findById']>,
    device: { id: string; name: string },
  ): Promise<void> {
    const settings = this.settings.forNode(access.nodeId);
    const panel = this.panelService.getState();
    const fromApp = user !== undefined && !isExpired(user, Date.now());

    if (access.kind === 'locked') {
      const wanted =
        (access.method === 'keypad' && fromApp && settings.armOnLockWithCode) ||
        (access.method === 'one_touch' && settings.armOnOneTouch);
      if (!wanted || panel.mode !== 'disarmed') {
        return;
      }
      this.skipEntryOf = 'armed_away';
      try {
        await this.panelService.arm('armed_away', {
          source: 'native',
          sourceUserId: user?.id ?? null,
          armSource: 'lock',
          actor: user?.name ?? `One-touch on ${access.label}`,
          device,
        });
      } catch (err) {
        this.skipEntryOf = null;
        throw err;
      }
      this.emit('lock_event', { nodeId: access.nodeId, kind: 'armed', userId: user?.id ?? null, method: access.method } satisfies LockEvent);
    } else if (access.kind === 'unlocked') {
      if (!(access.method === 'keypad' && fromApp && settings.disarmOnUnlock) || panel.mode === 'disarmed') {
        return;
      }
      this.skipEntryOf = 'disarmed';
      try {
        if (user.role === 'guest' && user.guestZoneId !== null) {
          await this.panelService.disarmZone(user.guestZoneId, {
            source: 'native',
            sourceUserId: user.id,
            clearedBy: user.name,
            actor: user.name,
            device,
          });
        } else {
          await this.panelService.disarm({ source: 'native', sourceUserId: user.id, clearedBy: user.name, actor: user.name, device });
        }
      } catch (err) {
        this.skipEntryOf = null;
        throw err;
      }
      this.emit('lock_event', { nodeId: access.nodeId, kind: 'disarmed', userId: user.id, method: access.method } satisfies LockEvent);
    }
  }

  /** When the panel enters a mode, lock or unlock the locks that have an action for it. */
  private async handlePanel(panel: AlarmPanel): Promise<void> {
    const previous = this.lastMode;
    this.lastMode = panel.mode;
    const mode = MODE_KEYS[panel.mode];
    if (mode === undefined || panel.mode === previous) {
      if (panel.mode !== 'arming' && mode === undefined) {
        this.skipEntryOf = null; // an alarm cut the lock-driven change short
      }
      return;
    }
    if (this.skipEntryOf !== null) {
      const skipped = this.skipEntryOf === mode;
      this.skipEntryOf = null;
      if (skipped) {
        return;
      }
    }
    for (const lock of this.locks.list()) {
      const action = this.settings.forNode(lock.nodeId).actions[mode];
      if (action === null || lock.locked === (action === 'lock')) {
        continue;
      }
      try {
        await this.locks.setLocked(lock.nodeId, action === 'lock');
      } catch (err) {
        logger.warn('could not move a lock for the new mode', {
          nodeId: lock.nodeId,
          mode,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
