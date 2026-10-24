import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { KeypadSettingsRepository, KeypadSettingsService } from '../../src/keypads/keypad-settings.js';

function build(requireCodeToArm = false) {
  const db = createDatabase(':memory:');
  return new KeypadSettingsService(new KeypadSettingsRepository(db), { requireCodeToArm });
}

describe('KeypadSettingsService', () => {
  it.each([true, false])('falls back to the environment default (%s) until a value is chosen', (fallback) => {
    expect(build(fallback).get()).toEqual({ requireCodeToArm: fallback });
  });

  it('persists a chosen value over the default', () => {
    const db = createDatabase(':memory:');
    const first = new KeypadSettingsService(new KeypadSettingsRepository(db), { requireCodeToArm: false });
    first.update({ requireCodeToArm: true });

    const afterRestart = new KeypadSettingsService(new KeypadSettingsRepository(db), { requireCodeToArm: false });
    expect(afterRestart.get()).toEqual({ requireCodeToArm: true });
  });

  it('emits settings_changed only when the value actually changes', () => {
    const service = build(false);
    const listener = vi.fn();
    service.on('settings_changed', listener);

    service.update({ requireCodeToArm: false });
    expect(listener).not.toHaveBeenCalled();

    service.update({ requireCodeToArm: true });
    expect(listener).toHaveBeenCalledWith({ requireCodeToArm: true });
  });

  it('ignores an empty update', () => {
    const service = build(true);
    expect(service.update({})).toEqual({ requireCodeToArm: true });
  });
});
