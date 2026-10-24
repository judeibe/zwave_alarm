import { describe, expect, it } from 'vitest';
import { lockedFromAccessControlEvent, lockedFromDoorLockMode } from '../../src/locks/schlage.js';

describe('lock state mapping', () => {
  it('maps Door Lock modes', () => {
    expect(lockedFromDoorLockMode(0xff)).toBe(true);
    expect(lockedFromDoorLockMode(0x00)).toBe(false);
    expect(lockedFromDoorLockMode(0x10)).toBe(false);
    expect(lockedFromDoorLockMode(0xfe)).toBeNull();
  });

  it('maps Access Control notification events', () => {
    for (const event of [0x01, 0x03, 0x05, 0x09]) expect(lockedFromAccessControlEvent(event)).toBe(true);
    for (const event of [0x02, 0x04, 0x06]) expect(lockedFromAccessControlEvent(event)).toBe(false);
    for (const event of [0x0b, 0x11, 0x00]) expect(lockedFromAccessControlEvent(event)).toBeUndefined();
  });
});
