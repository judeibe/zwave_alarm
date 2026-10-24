import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LockCommunicationError, LockNotFoundError, LockNotSecureError, LockService, LockUnsupportedError, type LockEnrollmentStore, type LockPort } from '../../src/locks/lock-service.js';
import { LockValueError } from '../../src/locks/schlage.js';

const BE469 = { model: 'BE469', label: 'Schlage BE469' } as const;
const BE468 = { model: 'BE468', label: 'Schlage BE468' } as const;

function buildPort(raw: Record<number, number> = {}) {
  const port = {
    readParameter: vi.fn((_nodeId: number, parameter: number) => Promise.resolve(raw[parameter])),
    writeParameter: vi.fn((_n: number, parameter: number, _size: 1 | 4, value: number) => {
      raw[parameter] = value;
      return Promise.resolve();
    }),
    setUserCode: vi.fn().mockResolvedValue(undefined),
    clearUserCode: vi.fn().mockResolvedValue(undefined),
    getUserSlot: vi.fn((_n: number, userId: number) => Promise.resolve({ userId, status: 'enabled' as const })),
    getScheduleSlotCounts: vi.fn().mockResolvedValue({ weekDay: 7, yearDay: 7, dailyRepeating: 7 }),
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    setSchedule: vi.fn().mockResolvedValue(undefined),
    getSchedule: vi.fn().mockResolvedValue(undefined),
  };
  return port satisfies LockPort;
}

function buildStore(enrolled: number[] = []) {
  const nodeIds = new Set(enrolled);
  return {
    isEnrolled: (nodeId: number) => nodeIds.has(nodeId),
    enroll: (nodeId: number) => void nodeIds.add(nodeId),
    unenroll: (nodeId: number) => void nodeIds.delete(nodeId),
  } satisfies LockEnrollmentStore;
}

describe('LockService', () => {
  let raw: Record<number, number>;
  let port: ReturnType<typeof buildPort>;
  let service: LockService;

  beforeEach(() => {
    raw = { 3: 0xff, 4: 0, 5: 0, 6: 0x01_00_00_00, 7: 1, 8: 3, 9: 3, 10: 5, 11: 0xff, 12: 1200, 13: 40, 14: 2, 15: 0xff, 16: 6, 17: 7, 18: 4 };
    port = buildPort(raw);
    service = new LockService(port, buildStore([5, 6]));
    service.add(5, BE469);
    service.add(6, BE468);
  });

  it('refreshes every parameter the model has into a summary', async () => {
    const changed = vi.fn();
    service.on('lock_changed', changed);

    const summary = await service.refresh(5);

    expect(summary.settings).toEqual({
      beeper: true,
      vacationMode: false,
      lockAndLeave: false,
      autoLock: true,
      pinLength: 6,
      alarmMode: 'alert',
      alertSensitivity: 3,
      tamperSensitivity: 3,
      kickSensitivity: 5,
      localControls: true,
    });
    expect(summary.diagnostics).toMatchObject({
      electronicTransitionCount: 1200,
      mechanicalTransitionCount: 40,
      electronicFailedCount: 2,
      electronicHighPreloadTransitionCount: 7,
      bootloaderVersion: 4,
      userSlotBitField: [1, 0, 0, 0],
      occupiedUserSlots: [1],
    });
    expect(summary.scheduleSlots).toEqual({ weekDay: 7, yearDay: 7, dailyRepeating: 7 });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 5 }));
  });

  it('never reads or reports the BE469-only parameters on a BE468', async () => {
    const summary = await service.refresh(6);

    expect(port.readParameter).not.toHaveBeenCalledWith(6, 7);
    expect(summary.settings.alarmMode).toBeNull();
    expect(summary.settings.localControls).toBeNull();
    expect(summary.supportedSettings).not.toContain('alarmMode');
    expect(summary.supportedSettings).toContain('pinLength');
  });

  it('keeps going when one parameter read fails', async () => {
    port.readParameter.mockImplementation((_n, parameter) => (parameter === 3 ? Promise.reject(new Error('timeout')) : Promise.resolve(raw[parameter])));

    const summary = await service.refresh(5);

    expect(summary.settings.beeper).toBeNull();
    expect(summary.settings.autoLock).toBe(true);
  });

  it('writes validated settings with the wire encoding', async () => {
    const summary = await service.updateSettings(5, { vacationMode: true, alarmMode: 'tamper', pinLength: 8, localControls: false });

    expect(port.writeParameter).toHaveBeenCalledWith(5, 4, 1, 0xff);
    expect(port.writeParameter).toHaveBeenCalledWith(5, 7, 1, 2);
    expect(port.writeParameter).toHaveBeenCalledWith(5, 16, 1, 8);
    expect(port.writeParameter).toHaveBeenCalledWith(5, 11, 1, 0);
    expect(summary.settings).toMatchObject({ vacationMode: true, alarmMode: 'tamper', pinLength: 8, localControls: false });
  });

  it('writes nothing when any setting in the request is invalid', async () => {
    await expect(service.updateSettings(5, { beeper: true, pinLength: 3 })).rejects.toBeInstanceOf(LockValueError);
    expect(port.writeParameter).not.toHaveBeenCalled();
  });

  it('refuses BE469-only settings on a BE468', async () => {
    await expect(service.updateSettings(6, { alarmMode: 'alert' })).rejects.toBeInstanceOf(LockUnsupportedError);
    await expect(service.updateSettings(6, { kickSensitivity: 1 })).rejects.toBeInstanceOf(LockUnsupportedError);
    await expect(service.updateSettings(6, { beeper: false })).resolves.toBeDefined();
  });

  it('wraps a failed write as a communication error', async () => {
    port.writeParameter.mockRejectedValueOnce(new Error('no ack'));
    await expect(service.updateSettings(5, { beeper: true })).rejects.toBeInstanceOf(LockCommunicationError);
  });

  it('rejects unknown locks and read-only keys', async () => {
    await expect(service.refresh(99)).rejects.toBeInstanceOf(LockNotFoundError);
    await expect(service.updateSettings(5, { electronicFailedCount: 0 } as never)).rejects.toBeInstanceOf(LockValueError);
  });

  describe('user codes', () => {
    beforeEach(async () => {
      await service.refresh(5); // PIN length 6
    });

    it('sets a code of the configured PIN length and re-reads the occupied slots', async () => {
      raw[6] = 0x03_00_00_00;
      const slot = await service.setUserCode(5, 2, '123456');

      expect(port.setUserCode).toHaveBeenCalledWith(5, 2, 'enabled', '123456');
      expect(slot).toEqual({ userId: 2, status: 'enabled' });
      expect(service.get(5).diagnostics.occupiedUserSlots).toEqual([1, 2]);
    });

    it('rejects a code that does not match the PIN length, and bad slots', async () => {
      await expect(service.setUserCode(5, 2, '1234')).rejects.toBeInstanceOf(LockValueError);
      await expect(service.setUserCode(5, 2, 'abcdef')).rejects.toBeInstanceOf(LockValueError);
      await expect(service.setUserCode(5, 0, '123456')).rejects.toBeInstanceOf(LockValueError);
      await expect(service.setUserCode(5, 31, '123456')).rejects.toBeInstanceOf(LockValueError);
      expect(port.setUserCode).not.toHaveBeenCalled();
    });

    it('accepts any 4-8 digit code before the PIN length is known', async () => {
      const fresh = new LockService(buildPort(), buildStore([7]));
      fresh.add(7, BE469);
      await expect(fresh.setUserCode(7, 1, '12345')).resolves.toBeDefined();
    });

    it('clears a code', async () => {
      await service.clearUserCode(5, 1);
      expect(port.clearUserCode).toHaveBeenCalledWith(5, 1);
    });

    it('lists 30 slots, asking the lock only about occupied ones', async () => {
      const users = await service.listUsers(5);

      expect(users).toHaveLength(30);
      expect(users[0]).toEqual({ userId: 1, status: 'enabled' });
      expect(users[1]).toEqual({ userId: 2, status: 'available' });
      expect(port.getUserSlot).toHaveBeenCalledTimes(1);
    });
  });

  describe('schedules', () => {
    it('sets, reads and clears a schedule of each kind', async () => {
      await service.refresh(5);
      const weekDay = { weekday: 1, startHour: 8, startMinute: 0, stopHour: 17, stopMinute: 30 };

      await service.setSchedule(5, 'weekDay', 2, 1, weekDay);
      await service.clearSchedule(5, 'dailyRepeating', 2, 3);
      await service.getSchedule(5, 'yearDay', 2, 1);

      expect(port.setSchedule).toHaveBeenCalledWith(5, 'weekDay', 2, 1, weekDay);
      expect(port.setSchedule).toHaveBeenCalledWith(5, 'dailyRepeating', 2, 3, undefined);
      expect(port.getSchedule).toHaveBeenCalledWith(5, 'yearDay', 2, 1);
    });

    it('enforces the slot count the lock reported', async () => {
      await service.refresh(5);
      await expect(service.clearSchedule(5, 'weekDay', 1, 8)).rejects.toBeInstanceOf(LockValueError);
      await expect(service.clearSchedule(5, 'weekDay', 1, 0)).rejects.toBeInstanceOf(LockValueError);
    });

    it('enables and disables schedules for one user', async () => {
      await service.setScheduleEnabled(5, 3, false);
      expect(port.setScheduleEnabled).toHaveBeenCalledWith(5, 3, false);
    });

    it('reads the slot counts on demand', async () => {
      expect(await service.scheduleSlots(5)).toEqual({ weekDay: 7, yearDay: 7, dailyRepeating: 7 });
      await service.scheduleSlots(5);
      expect(port.getScheduleSlotCounts).toHaveBeenCalledTimes(1);
    });
  });

  it('records an unsolicited configuration report and ignores parameters the model lacks', () => {
    const changed = vi.fn();
    service.on('lock_changed', changed);

    service.recordReport(5, 3, 0);
    service.recordReport(6, 7, 1);

    expect(service.get(5).settings.beeper).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  describe('enrollment', () => {
    it('hides a paired lock from clients until it is enrolled', async () => {
      const changed = vi.fn();
      service.on('lock_changed', changed);
      service.add(7, BE469, { secure: true });
      service.updateStatus(7, { batteryLevel: 50 });

      expect(service.list().map((lock) => lock.nodeId)).toEqual([5, 6]);
      expect(service.listAvailable()).toEqual([{ nodeId: 7, model: 'BE469', label: BE469.label, connectivityStatus: 'online', secure: true }]);
      expect(() => service.get(7)).toThrow(LockNotFoundError);
      await expect(service.refresh(7)).rejects.toBeInstanceOf(LockNotFoundError);
      await expect(service.setUserCode(7, 1, '1234')).rejects.toBeInstanceOf(LockNotFoundError);
      expect(changed).not.toHaveBeenCalled();
      expect(port.readParameter).not.toHaveBeenCalledWith(7, expect.anything());
    });

    it('enrolls a lock, reads its state and announces it', async () => {
      const changed = vi.fn();
      service.add(7, BE469, { secure: true });
      service.on('lock_changed', changed);

      const summary = await service.enroll(7);

      expect(summary).toMatchObject({ nodeId: 7, settings: { beeper: true }, scheduleSlots: { weekDay: 7 } });
      expect(service.list().map((lock) => lock.nodeId)).toEqual([5, 6, 7]);
      expect(service.listAvailable()).toEqual([]);
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 7 }));
      await expect(service.enroll(7)).resolves.toMatchObject({ nodeId: 7 });
    });

    it('refuses to enroll an unknown lock, or one included without security', async () => {
      service.add(7, BE469, { secure: false });

      await expect(service.enroll(99)).rejects.toBeInstanceOf(LockNotFoundError);
      await expect(service.enroll(7)).rejects.toBeInstanceOf(LockNotSecureError);
      expect(service.list().map((lock) => lock.nodeId)).toEqual([5, 6]);
    });

    it('unenrolls a lock, announcing the removal, and sends it back to available', () => {
      const removed = vi.fn();
      service.on('lock_removed', removed);

      service.unenroll(5);
      service.unenroll(5);

      expect(removed).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith(5);
      expect(service.list().map((lock) => lock.nodeId)).toEqual([6]);
      expect(service.listAvailable().map((lock) => lock.nodeId)).toEqual([5]);
      expect(() => service.get(5)).toThrow(LockNotFoundError);
      expect(() => service.unenroll(99)).toThrow(LockNotFoundError);
    });

    it('drops the enrollment of a lock that leaves the network', () => {
      const removed = vi.fn();
      service.on('lock_removed', removed);

      service.remove(5);
      service.remove(99);

      expect(removed).toHaveBeenCalledOnce();
      expect(service.isEnrolled(5)).toBe(false);
      expect(service.listAvailable()).toEqual([]);
    });
  });

  describe('capabilities', () => {
    it('derives schedule support from the slot counts, and unknown before they are read', async () => {
      expect(service.get(5).capabilities).toEqual({
        secure: null,
        userCodes: true,
        schedules: { weekDay: null, yearDay: null, dailyRepeating: null },
        alarmSettings: true,
      });
      port.getScheduleSlotCounts.mockResolvedValue({ weekDay: 7, yearDay: 7, dailyRepeating: 0 });

      await service.refresh(5);

      expect(service.get(5).capabilities.schedules).toEqual({ weekDay: true, yearDay: true, dailyRepeating: false });
      expect(service.get(6).capabilities.alarmSettings).toBe(false);
    });

    it('rejects a schedule kind the lock has no slots for', async () => {
      port.getScheduleSlotCounts.mockResolvedValue({ weekDay: 7, yearDay: 0, dailyRepeating: 0 });
      await service.refresh(5);

      await expect(service.getSchedule(5, 'yearDay', 1, 1)).rejects.toBeInstanceOf(LockUnsupportedError);
      await expect(service.clearSchedule(5, 'dailyRepeating', 1, 1)).rejects.toBeInstanceOf(LockUnsupportedError);
      expect(port.setSchedule).not.toHaveBeenCalled();
    });
  });
});
