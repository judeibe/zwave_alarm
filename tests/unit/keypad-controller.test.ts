import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { UserRepository } from '../../src/auth/user-repository.js';
import { LockoutPolicyRepository } from '../../src/auth/lockout-policy-repository.js';
import { LockoutService } from '../../src/auth/lockout-service.js';
import { KeypadService } from '../../src/keypads/keypad-service.js';
import { KeypadController } from '../../src/keypads/keypad-controller.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';

const NODE = 12;
const DELAY_MS = 30;

const INDICATOR = CommandClasses.Indicator;
const indicatorWrite = (property: number, propertyKey: number, value: number) => ({
  commandClass: INDICATOR,
  endpoint: 0,
  property,
  propertyKey,
  value,
});

const entryControl = (eventType: number, eventData?: string) => ({
  commandClass: CommandClasses['Entry Control'],
  args: { eventType, eventData },
});

function build(options: { requireCodeToArm?: boolean } = {}) {
  const db = createDatabase(':memory:');
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const userRepo = new UserRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo, {
    exitDelayMs: DELAY_MS,
    entryDelayMs: DELAY_MS,
  });
  const lockoutService = new LockoutService(userRepo, new LockoutPolicyRepository(db), eventRepo, panelService);

  const writes: Array<{ nodeId: number; writes: unknown[] }> = [];
  const keypads = new KeypadService((nodeId, w) => {
    writes.push({ nodeId, writes: w });
    return Promise.resolve();
  });
  keypads.add(NODE, ringKeypadV2Adapter);
  new KeypadController(keypads, panelService, userRepo, lockoutService, eventRepo, zoneRepo, {
    requireCodeToArm: options.requireCodeToArm ?? false,
  }).start();
  writes.length = 0; // drop the sync-on-add indication; tests look at what happens afterwards

  const wrote = (...expected: unknown[]) => writes.some((entry) => JSON.stringify(entry.writes) === JSON.stringify(expected));
  return { panelService, keypads, userRepo, zoneRepo, eventRepo, writes, wrote };
}

/** `arm()` resolves once the exit delay has started, so wait for the armed mode to actually be committed. */
async function armPanel(panelService: PanelService, mode: 'armed_away' | 'armed_home'): Promise<void> {
  await panelService.arm(mode, { source: 'native' });
  await vi.waitFor(() => expect(panelService.getState().mode).toBe(mode));
}

describe('KeypadController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('disarming', () => {
    it('disarms with a valid code', async () => {
      const { panelService, keypads, userRepo } = build();
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(2, '1234'));

      await vi.waitFor(() => expect(panelService.getState().mode).toBe('disarmed'));
    });

    it('disarms from the Disarm button when a code was typed first', async () => {
      const { panelService, keypads, userRepo } = build();
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });
      await armPanel(panelService, 'armed_home');

      keypads.receive(NODE, entryControl(3, '1234'));

      await vi.waitFor(() => expect(panelService.getState().mode).toBe('disarmed'));
    });

    it('keeps the panel armed and plays the rejected tone for a wrong code', async () => {
      const { panelService, keypads, userRepo, wrote } = build();
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(2, '9999'));

      await vi.waitFor(() => expect(wrote(indicatorWrite(9, 1, 1))).toBe(true));
      expect(panelService.getState().mode).toBe('armed_away');
    });

    it('rejects the Disarm button when no code was typed', async () => {
      const { panelService, keypads, userRepo, wrote } = build();
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(3));

      await vi.waitFor(() => expect(wrote(indicatorWrite(9, 1, 1))).toBe(true));
      expect(panelService.getState().mode).toBe('armed_away');
    });

    it('does nothing when a code is entered while already disarmed', async () => {
      const { panelService, keypads, userRepo, writes } = build();
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });

      keypads.receive(NODE, entryControl(2, '9999'));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(panelService.getState().mode).toBe('disarmed');
      expect(writes).toEqual([]);
    });

    it('refuses a locked account and an expired guest code like a wrong code', async () => {
      const { panelService, keypads, userRepo } = build();
      const locked = userRepo.create({ name: 'Locked', role: 'member', code: '1111' });
      userRepo.lock(locked.id, 300);
      userRepo.create({ name: 'Old guest', role: 'guest', code: '2222', guestExpiresAt: Date.now() - 1000 });
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(2, '1111'));
      keypads.receive(NODE, entryControl(2, '2222'));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(panelService.getState().mode).toBe('armed_away');
    });

    it('lets a zone-restricted guest disarm only their zone, and records the guest code use', async () => {
      const { panelService, keypads, userRepo, zoneRepo, eventRepo } = build();
      const zone = zoneRepo.create('Garage');
      const guest = userRepo.create({
        name: 'Gus',
        role: 'guest',
        code: '4321',
        guestExpiresAt: Date.now() + 100_000,
        guestZoneId: zone.id,
      });
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(2, '4321'));

      await vi.waitFor(() => expect(panelService.getState().disarmedZoneIds).toEqual([zone.id]));
      expect(panelService.getState().mode).toBe('armed_away');
      expect(eventRepo.list().some((event) => event.type === 'guest_code_used' && event.sourceUserId === guest.id)).toBe(true);
    });
  });

  describe('arming', () => {
    it('arms away from the Arm Away button without a code by default', async () => {
      const { panelService, keypads } = build();

      keypads.receive(NODE, entryControl(5));

      await vi.waitFor(() => expect(panelService.getState().mode).toBe('armed_away'));
    });

    it('arms home from the Arm Home button', async () => {
      const { panelService, keypads } = build();

      keypads.receive(NODE, entryControl(6));

      await vi.waitFor(() => expect(panelService.getState().mode).toBe('armed_home'));
    });

    it('needs a valid code to arm when KEYPAD_REQUIRE_CODE_TO_ARM is on', async () => {
      const { panelService, keypads, userRepo, wrote } = build({ requireCodeToArm: true });
      userRepo.create({ name: 'Ada', role: 'administrator', code: '1234' });

      keypads.receive(NODE, entryControl(5));
      await vi.waitFor(() => expect(wrote(indicatorWrite(9, 1, 1))).toBe(true));
      expect(panelService.getState().mode).toBe('disarmed');

      keypads.receive(NODE, entryControl(5, '1234'));
      await vi.waitFor(() => expect(panelService.getState().mode).toBe('armed_away'));
    });

    it('ignores an arm request that the panel refuses, such as arming while already armed', async () => {
      const { panelService, keypads } = build();
      await armPanel(panelService, 'armed_away');

      keypads.receive(NODE, entryControl(6));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(panelService.getState().mode).toBe('armed_away');
    });
  });

  describe('emergency buttons', () => {
    it.each([
      [16, 'fire'],
      [17, 'police'],
      [19, 'medical'],
    ])('event type %i triggers the alarm and says which button', async (eventType, emergency) => {
      const { panelService, keypads, eventRepo } = build();

      keypads.receive(NODE, entryControl(eventType));

      await vi.waitFor(() => expect(panelService.getState().mode).toBe('alarm_triggered'));
      expect(eventRepo.list().find((event) => event.type === 'alarm_triggered')?.details).toContain(emergency);
    });
  });

  describe('mirroring the panel on the keypad', () => {
    it('shows the exit delay, then the armed mode', async () => {
      const { panelService, writes, wrote } = build();

      await panelService.arm('armed_away', { source: 'native' });
      expect(writes[0]?.writes).toEqual([indicatorWrite(18, 7, 1)]);

      await vi.waitFor(() => expect(wrote(indicatorWrite(11, 1, 99))).toBe(true));
    });

    it('shows the disarmed mode again after disarming', async () => {
      const { panelService, wrote } = build();
      await armPanel(panelService, 'armed_home');

      await panelService.disarm({ source: 'native' });

      await vi.waitFor(() => expect(wrote(indicatorWrite(2, 1, 99))).toBe(true));
    });

    it('sounds the alarm on the keypad when the alarm triggers', async () => {
      const { panelService, wrote } = build();

      panelService.triggerAlarm({ details: 'test' });

      await vi.waitFor(() => expect(wrote(indicatorWrite(13, 1, 1))).toBe(true));
    });

    it('shows the current state on a keypad that appears or comes back online', async () => {
      const { panelService, keypads, writes } = build();
      await armPanel(panelService, 'armed_home');
      writes.length = 0;

      keypads.updateStatus(NODE, { connectivityStatus: 'offline' });
      expect(writes).toEqual([]);
      keypads.updateStatus(NODE, { connectivityStatus: 'online' });

      await vi.waitFor(() => expect(writes[0]?.writes).toEqual([indicatorWrite(10, 1, 99)]));
    });
  });
});
