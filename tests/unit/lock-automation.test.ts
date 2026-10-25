import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockService, type LockPort } from '../../src/locks/lock-service.js';
import { LockModeSettingsRepository } from '../../src/locks/lock-mode-settings.js';
import { LockCodeSlotRepository } from '../../src/locks/lock-code-slots.js';
import { LockCodeSync } from '../../src/locks/lock-code-sync.js';
import { LockAutomation, type LockEvent } from '../../src/locks/lock-automation.js';

const BE469 = { model: 'BE469', label: 'Front door' } as const;
const BE468 = { model: 'BE468', label: 'Back door' } as const;

function buildPort() {
  const codes = new Map<string, number>(); // `${node}:${slot}` -> present
  const port = {
    readParameter: vi.fn().mockResolvedValue(undefined),
    writeParameter: vi.fn().mockResolvedValue(undefined),
    setUserCode: vi.fn((node: number, slot: number) => {
      codes.set(`${String(node)}:${String(slot)}`, 1);
      return Promise.resolve();
    }),
    clearUserCode: vi.fn((node: number, slot: number) => {
      codes.delete(`${String(node)}:${String(slot)}`);
      return Promise.resolve();
    }),
    getUserSlot: vi.fn((node: number, slot: number) =>
      Promise.resolve({ userId: slot, status: codes.has(`${String(node)}:${String(slot)}`) ? ('enabled' as const) : ('available' as const) }),
    ),
    getScheduleSlotCounts: vi.fn().mockResolvedValue(undefined),
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    setSchedule: vi.fn().mockResolvedValue(undefined),
    getSchedule: vi.fn().mockResolvedValue(undefined),
    setLocked: vi.fn().mockResolvedValue(undefined),
    getLocked: vi.fn().mockResolvedValue(undefined),
  };
  return { port: port satisfies LockPort, codes };
}

function build() {
  const db = createDatabase(':memory:');
  const { port, codes } = buildPort();
  const eventRepo = new EventRepository(db);
  const userRepo = new UserRepository(db);
  const settings = new LockModeSettingsRepository(db);
  const slots = new LockCodeSlotRepository(db);
  const sensorRepo = new SensorRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, { exitDelayMs: 1000, entryDelayMs: 1000, sensorRepo });
  const enrolled = new Set([5, 6]);
  const locks = new LockService(port, { isEnrolled: (n) => enrolled.has(n), enroll: (n) => void enrolled.add(n), unenroll: (n) => void enrolled.delete(n) }, settings);
  locks.add(5, BE469);
  locks.add(6, BE468);
  const sync = new LockCodeSync(locks, slots);
  const automation = new LockAutomation(locks, panelService, userRepo, eventRepo, settings, slots);
  automation.start();
  const lockEvents: LockEvent[] = [];
  automation.on('lock_event', (event: LockEvent) => lockEvents.push(event));
  const zone = new ZoneRepository(db).create('House');
  return { db, port, codes, eventRepo, userRepo, settings, slots, sensorRepo, panelService, locks, sync, automation, lockEvents, zone };
}

describe('pushing codes to locks', () => {
  it('writes a user\'s code to the lowest free slot of every enrolled lock, and reuses it when the code changes', async () => {
    const { sync, userRepo, slots, port } = build();
    const ada = userRepo.create({ name: 'Ada', role: 'member', code: '1111' });
    const bob = userRepo.create({ name: 'Bob', role: 'member', code: '2222' });

    const first = await sync.push(ada.id, '1111');
    const second = await sync.push(bob.id, '2222');
    const again = await sync.push(ada.id, '3333');

    expect(first).toEqual([{ nodeId: 5, slot: 1, status: 'synced' }, { nodeId: 6, slot: 1, status: 'synced' }]);
    expect(second.map((r) => r.slot)).toEqual([2, 2]);
    expect(again.map((r) => r.slot)).toEqual([1, 1]);
    expect(port.setUserCode).toHaveBeenCalledWith(5, 1, 'enabled', '3333');
    expect(slots.forUser(ada.id)).toHaveLength(2);
  });

  it('skips slots that already hold a code on the lock', async () => {
    const { sync, userRepo, codes } = build();
    codes.set('5:1', 1); // programmed on the lock itself
    codes.set('5:2', 1);
    const ada = userRepo.create({ name: 'Ada', role: 'member', code: '1111' });

    const results = await sync.push(ada.id, '1111');

    expect(results.find((r) => r.nodeId === 5)?.slot).toBe(3);
  });

  it('reports a lock that refuses the code as failed, keeps the others, and never marks it synced', async () => {
    const { sync, userRepo, port, slots } = build();
    port.setUserCode.mockImplementationOnce(() => Promise.reject(new Error('lock is asleep')));
    const ada = userRepo.create({ name: 'Ada', role: 'member', code: '1111' });

    const results = await sync.push(ada.id, '1111');

    expect(results[0]).toMatchObject({ nodeId: 5, status: 'failed', slot: 1 });
    expect(results[0].message).toBeTruthy();
    expect(results[1]).toMatchObject({ nodeId: 6, status: 'synced' });
    expect(slots.find(5, ada.id)?.status).toBe('failed');
    expect(slots.findUserBySlot(5, 1)).toBeUndefined(); // a failed slot never arms or disarms
  });

  it('clears the slots on removal, freeing them for the next user', async () => {
    const { sync, userRepo, slots, codes } = build();
    const ada = userRepo.create({ name: 'Ada', role: 'member', code: '1111' });
    await sync.push(ada.id, '1111');

    const cleared = await sync.clear(ada.id);

    expect(cleared.map((r) => r.status)).toEqual(['synced', 'synced']);
    expect(slots.forUser(ada.id)).toEqual([]);
    expect(codes.size).toBe(0);
  });

  it('keeps the slot as failed when it cannot be cleared', async () => {
    const { sync, userRepo, slots, port } = build();
    const ada = userRepo.create({ name: 'Ada', role: 'member', code: '1111' });
    await sync.push(ada.id, '1111');
    port.clearUserCode.mockImplementationOnce(() => Promise.reject(new Error('offline')));

    const cleared = await sync.clear(ada.id);

    expect(cleared[0]).toMatchObject({ nodeId: 5, status: 'failed' });
    expect(slots.find(5, ada.id)?.status).toBe('failed');
  });
});

describe('lock-driven arming and disarming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function withSlot() {
    const h = build();
    const ada = h.userRepo.create({ name: 'Ada', role: 'member', code: '1111' });
    await h.sync.push(ada.id, '1111');
    return { ...h, ada };
  }

  it('arms AWAY when locked with an app code, bypassing faulted sensors, attributed to the user and the lock', async () => {
    const h = await withSlot();
    h.settings.update(5, { armOnLockWithCode: true });
    const door = h.sensorRepo.create({ zwaveNodeId: 9, zoneId: h.zone.id, name: 'Garage', category: 'intrusion', placement: 'WINDOW' });
    h.sensorRepo.updateState(door.id, { currentState: 'breached' });

    h.locks.recordAccess(5, 0x05, 1);
    await vi.advanceTimersByTimeAsync(10);

    expect(h.panelService.getState()).toMatchObject({ mode: 'arming', armedMode: 'armed_away', bypassedDeviceIds: [door.id] });
    const [armedEvent] = h.eventRepo.list({ types: ['bypassed'] });
    expect(armedEvent).toMatchObject({ actor: 'Ada', deviceId: door.id });
    expect(h.eventRepo.list({ types: ['lock_locked'] })[0]).toMatchObject({
      actor: 'Ada',
      deviceId: 'node-5',
      deviceName: 'Front door',
      details: 'Locked with a keypad code (Ada)',
    });
    expect(h.lockEvents.map((e) => e.kind)).toEqual(['locked', 'armed']);
    expect(h.lockEvents[1]).toMatchObject({ nodeId: 5, userId: h.ada.id, method: 'keypad' });
  });

  it('does nothing when the setting is off, the code is not an app code, or the panel is already armed', async () => {
    const h = await withSlot();

    h.locks.recordAccess(5, 0x05, 1); // setting off
    h.settings.update(5, { armOnLockWithCode: true });
    h.locks.recordAccess(5, 0x05, 17); // a code programmed on the lock itself
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState().mode).toBe('disarmed');
    expect(h.eventRepo.list({ types: ['lock_locked'] })[0].details).toContain('slot 17');

    await h.panelService.arm('armed_home', { source: 'native' });
    await vi.advanceTimersByTimeAsync(1100);
    h.locks.recordAccess(5, 0x05, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState().armedMode).toBe('armed_home'); // not switched to away
  });

  it('arms for the one-touch button only when armOnOneTouch is on', async () => {
    const h = build();

    h.locks.recordAccess(5, 0x05);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState().mode).toBe('disarmed');

    h.settings.update(5, { armOnOneTouch: true });
    h.locks.recordAccess(5, 0x05);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState()).toMatchObject({ mode: 'arming', armedMode: 'armed_away' });
    expect(h.eventRepo.list({ types: ['lock_locked'] })[0].actor).toBe('One-touch');
    expect(h.lockEvents.map((e) => e.method)).toEqual(['one_touch', 'one_touch', 'one_touch']);
  });

  it('disarms when unlocked with an app code if disarmOnUnlock is on, not for other codes or manual unlocks', async () => {
    const h = await withSlot();
    await h.panelService.arm('armed_away', { source: 'native' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.panelService.getState().mode).toBe('armed_away');

    h.locks.recordAccess(5, 0x06, 1); // setting off
    h.settings.update(5, { disarmOnUnlock: true });
    h.locks.recordAccess(5, 0x06, 17); // not ours
    h.locks.recordAccess(5, 0x02); // by hand
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState().mode).toBe('armed_away');

    h.locks.recordAccess(5, 0x06, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.panelService.getState().mode).toBe('disarmed');
    expect(h.eventRepo.list({ types: ['disarmed'] })[0]).toMatchObject({ actor: 'Ada', deviceId: 'node-5', deviceName: 'Front door' });
    expect(h.lockEvents.at(-1)).toMatchObject({ kind: 'disarmed', userId: h.ada.id });
  });

  it('only the lock used reacts: other locks with a mode action are not commanded for a lock-driven change', async () => {
    const h = await withSlot();
    h.settings.update(5, { armOnLockWithCode: true });
    h.settings.update(6, { actions: { armed_away: 'lock', disarmed: 'unlock' } });

    h.locks.recordAccess(5, 0x05, 1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.panelService.getState().mode).toBe('armed_away');
    expect(h.port.setLocked).not.toHaveBeenCalled();
  });
});

describe('per-mode lock actions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks or unlocks a lock when the panel enters a mode, and skips a lock already in that state', async () => {
    const h = build();
    h.settings.update(5, { actions: { armed_away: 'lock', disarmed: 'unlock' } });

    await h.panelService.arm('armed_away', { source: 'native' });
    expect(h.port.setLocked).not.toHaveBeenCalled(); // still in the exit delay
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.port.setLocked).toHaveBeenCalledWith(5, true);
    expect(h.port.setLocked).not.toHaveBeenCalledWith(6, expect.anything());

    h.locks.recordLocked(5, true);
    await h.panelService.disarm({ source: 'native' });
    expect(h.port.setLocked).toHaveBeenLastCalledWith(5, false);

    h.locks.recordLocked(5, false);
    h.port.setLocked.mockClear();
    await h.panelService.arm('armed_home', { source: 'native' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.port.setLocked).not.toHaveBeenCalled(); // armed_home has no action
  });

  it('does not act for the mode the panel was already in when the service started', () => {
    const h = build();
    h.settings.update(5, { actions: { disarmed: 'unlock' } });

    h.panelService.emit('panel_changed', h.panelService.getState());

    expect(h.port.setLocked).not.toHaveBeenCalled();
  });
});

describe('lock history', () => {
  it('records jams, and offline and online changes once the lock has been seen', () => {
    const h = build();
    h.locks.republish(5); // the first sighting sets the baseline and records nothing

    h.locks.recordAccess(5, 0x0b);
    h.locks.updateStatus(5, { connectivityStatus: 'offline' });
    h.locks.updateStatus(5, { connectivityStatus: 'online' });

    const events = h.eventRepo.list();
    expect(events.map((e) => e.type)).toEqual(['lock_online', 'lock_offline', 'lock_jammed']);
    expect(events[2]).toMatchObject({ deviceId: 'node-5', deviceName: 'Front door', source: 'system' });
    expect(h.lockEvents.map((e) => e.kind)).toEqual(['jammed']);
  });

  it('ignores notifications from a lock that is not enrolled', () => {
    const h = build();
    const seen: unknown[] = [];
    h.locks.on('lock_access', (access) => seen.push(access));

    h.locks.recordAccess(99, 0x05, 1);

    expect(seen).toEqual([]);
    expect(h.lockEvents).toEqual([]);
  });
});
