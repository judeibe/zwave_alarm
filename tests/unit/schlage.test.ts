import { describe, expect, it } from 'vitest';
import {
  LockValueError,
  SCHLAGE_PARAMETERS,
  decodeParameter,
  encodeParameter,
  getParameterByKey,
  identifySchlageLock,
  occupiedUserSlots,
  parametersForModel,
  userSlotBytes,
  validatePin,
} from '../../src/locks/schlage.js';

const param = (key: string) => {
  const definition = getParameterByKey(key);
  if (!definition) {
    throw new Error(`no ${key}`);
  }
  return definition;
};

describe('identifySchlageLock', () => {
  it('recognises the BE469 and BE468 including their ZP variants', () => {
    expect(identifySchlageLock({ manufacturerId: 0x3b, productType: 0x6341, productId: 0x5044 })?.model).toBe('BE469');
    expect(identifySchlageLock({ manufacturerId: 0x3b, productType: 0x6349, productId: 0x5044 })?.model).toBe('BE468');
    expect(identifySchlageLock({ manufacturerId: 0x3b, productType: 0x0001, productId: 0x0469 })?.model).toBe('BE469');
    expect(identifySchlageLock({ manufacturerId: 0x3b, productType: 0x0001, productId: 0x0468 })?.model).toBe('BE468');
  });

  it('ignores other manufacturers and unknown Schlage products', () => {
    expect(identifySchlageLock({ manufacturerId: 0x1234, productType: 0x6341, productId: 0x5044 })).toBeUndefined();
    expect(identifySchlageLock({ manufacturerId: 0x3b, productType: 0x9999, productId: 0x9999 })).toBeUndefined();
  });
});

describe('parameter table', () => {
  it('covers parameters 0x03 to 0x12 with unique numbers', () => {
    const numbers = SCHLAGE_PARAMETERS.map((definition) => definition.parameter).sort((a, b) => a - b);
    expect(numbers).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it('gates the alarm parameters (0x07 to 0x0B) to the BE469', () => {
    const be468 = parametersForModel('BE468').map((definition) => definition.parameter);
    expect(be468).not.toEqual(expect.arrayContaining([7]));
    for (const gated of [7, 8, 9, 10, 11]) {
      expect(be468).not.toContain(gated);
      expect(parametersForModel('BE469').map((definition) => definition.parameter)).toContain(gated);
    }
    expect(be468).toContain(3);
    expect(be468).toContain(16);
  });

  it('marks the slot bit field, counters and bootloader version read-only', () => {
    for (const key of ['userSlotBitField', 'electronicTransitionCount', 'mechanicalTransitionCount', 'electronicFailedCount', 'electronicHighPreloadTransitionCount', 'bootloaderVersion']) {
      expect(param(key).access).toBe('read-only');
    }
    expect(param('beeper').access).toBe('read-write');
  });
});

describe('encodeParameter / decodeParameter', () => {
  it('maps booleans to 0x00 and 0xFF', () => {
    expect(encodeParameter(param('beeper'), true)).toBe(0xff);
    expect(encodeParameter(param('autoLock'), false)).toBe(0x00);
    expect(decodeParameter(param('vacationMode'), 0xff)).toBe(true);
    expect(decodeParameter(param('lockAndLeave'), 0)).toBe(false);
    expect(() => encodeParameter(param('beeper'), 1)).toThrow(LockValueError);
  });

  it('maps the alarm mode names', () => {
    expect(encodeParameter(param('alarmMode'), 'forced_entry')).toBe(3);
    expect(decodeParameter(param('alarmMode'), 2)).toBe('tamper');
    expect(() => encodeParameter(param('alarmMode'), 'loud')).toThrow(LockValueError);
  });

  it('bounds sensitivities to 0-5 and the PIN length to 4-8', () => {
    expect(encodeParameter(param('kickSensitivity'), 3)).toBe(3);
    expect(() => encodeParameter(param('kickSensitivity'), 6)).toThrow(LockValueError);
    expect(encodeParameter(param('pinLength'), 8)).toBe(8);
    expect(() => encodeParameter(param('pinLength'), 3)).toThrow(LockValueError);
    expect(() => encodeParameter(param('pinLength'), 9)).toThrow(LockValueError);
    expect(() => encodeParameter(param('pinLength'), 4.5)).toThrow(LockValueError);
  });

  it('refuses to encode a read-only parameter', () => {
    expect(() => encodeParameter(param('electronicFailedCount'), 1)).toThrow(/read-only/);
  });
});

describe('user slot bit field', () => {
  it('splits bytes 1-3 for slots 1-24 and byte 4 for 25-30, LSB lowest', () => {
    expect(userSlotBytes(0x01_00_00_20)).toEqual([0x01, 0x00, 0x00, 0x20]);
    // byte 1 bit 0 = slot 1; byte 3 bit 7 = slot 24; byte 4 bit 0 = slot 25; byte 4 bit 5 = slot 30.
    expect(occupiedUserSlots(0x01_00_80_21)).toEqual([1, 24, 25, 30]);
    expect(occupiedUserSlots(0)).toEqual([]);
  });
});

describe('validatePin', () => {
  it('accepts 4-8 digits matching the configured length', () => {
    expect(() => validatePin('1234', 4)).not.toThrow();
    expect(() => validatePin('12345678', 8)).not.toThrow();
    expect(() => validatePin('123456', null)).not.toThrow();
  });

  it('rejects non-digits, out-of-range lengths and a mismatch with the lock setting', () => {
    expect(() => validatePin('12a4', null)).toThrow(/digits only/);
    expect(() => validatePin('123', null)).toThrow(/4 to 8/);
    expect(() => validatePin('123456789', null)).toThrow(/4 to 8/);
    expect(() => validatePin('123456', 4)).toThrow(/4-digit/);
  });
});
