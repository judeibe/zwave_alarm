import { describe, expect, it } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { ringKeypadV2Adapter as ring } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';

const ENTRY_CONTROL = CommandClasses['Entry Control'];
const INDICATOR = CommandClasses.Indicator;

function entryControl(eventType: number, eventData?: unknown) {
  return { commandClass: ENTRY_CONTROL, args: { eventType, dataType: 2, eventData } };
}

describe('ring keypad v2 adapter: identity', () => {
  it.each([0x0301, 0x0401])('recognises product id 0x%s', (productId) => {
    expect(ring.supports({ manufacturerId: 0x0346, productType: 0x0101, productId })).toBe(true);
  });

  it('does not recognise other Ring devices or other manufacturers', () => {
    expect(ring.supports({ manufacturerId: 0x0346, productType: 0x0101, productId: 0x0201 })).toBe(false);
    expect(ring.supports({ manufacturerId: 0x0346, productType: 0x0201, productId: 0x0301 })).toBe(false);
    expect(ring.supports({ manufacturerId: 0x0086, productType: 0x0101, productId: 0x0301 })).toBe(false);
  });

  it('declares its capabilities and chime sounds', () => {
    expect(ring.id).toBe('ring-keypad-v2');
    expect(ring.capabilities).toEqual(['arm_disarm', 'emergency', 'indicators', 'chime']);
    expect(ring.chimeSounds).toEqual(['double_beep', 'guitar', 'wind_chimes', 'bing_bong', 'doorbell']);
  });
});

describe('ring keypad v2 adapter: decodeInput', () => {
  it('decodes Enter with a code as code_entered', () => {
    expect(ring.decodeInput(entryControl(2, '1234'))).toEqual({ kind: 'code_entered', code: '1234' });
  });

  it('decodes a code delivered as raw bytes', () => {
    expect(ring.decodeInput(entryControl(2, Uint8Array.from([0x31, 0x32, 0x33, 0x34])))).toEqual({
      kind: 'code_entered',
      code: '1234',
    });
  });

  it('ignores Enter with no digits typed', () => {
    expect(ring.decodeInput(entryControl(2, ''))).toBeNull();
    expect(ring.decodeInput(entryControl(2))).toBeNull();
  });

  it('decodes arm and disarm buttons, with the code when one was typed first', () => {
    expect(ring.decodeInput(entryControl(3, '1234'))).toEqual({ kind: 'disarm', code: '1234' });
    expect(ring.decodeInput(entryControl(3))).toEqual({ kind: 'disarm' });
    expect(ring.decodeInput(entryControl(5))).toEqual({ kind: 'arm_away' });
    expect(ring.decodeInput(entryControl(6, '1234'))).toEqual({ kind: 'arm_home', code: '1234' });
  });

  it.each([
    [16, 'fire'],
    [17, 'police'],
    [19, 'medical'],
  ])('decodes event type %i as the %s emergency', (eventType, emergency) => {
    expect(ring.decodeInput(entryControl(eventType))).toEqual({ kind: 'emergency', emergency });
  });

  it('decodes Cancel', () => {
    expect(ring.decodeInput(entryControl(25))).toEqual({ kind: 'cancel' });
  });

  it('ignores caching events and unknown event types', () => {
    expect(ring.decodeInput(entryControl(0))).toBeNull();
    expect(ring.decodeInput(entryControl(1, '12'))).toBeNull();
    expect(ring.decodeInput(entryControl(99))).toBeNull();
  });

  it('ignores notifications from other command classes', () => {
    expect(ring.decodeInput({ commandClass: CommandClasses.Notification, args: { eventType: 2, eventData: '1234' } })).toBeNull();
  });
});

describe('ring keypad v2 adapter: encodeIndication', () => {
  const write = (property: number, propertyKey: number, value: number) => [
    { commandClass: INDICATOR, endpoint: 0, property, propertyKey, value },
  ];

  it.each([
    ['disarmed', 2],
    ['armed_home', 10],
    ['armed_away', 11],
  ] as const)('shows %s on indicator %i at full brightness', (mode, indicator) => {
    expect(ring.encodeIndication({ kind: 'mode', mode })).toEqual(write(indicator, 1, 99));
  });

  it('sounds the burglar alarm', () => {
    expect(ring.encodeIndication({ kind: 'alarm' })).toEqual(write(13, 1, 1));
  });

  it('starts entry and exit delays with their length in seconds', () => {
    expect(ring.encodeIndication({ kind: 'entry_delay', seconds: 30 })).toEqual(write(17, 7, 30));
    expect(ring.encodeIndication({ kind: 'exit_delay', seconds: 45 })).toEqual(write(18, 7, 45));
  });

  it('clamps delay lengths into the 1-255 second range', () => {
    expect(ring.encodeIndication({ kind: 'exit_delay', seconds: 0 })).toEqual(write(18, 7, 1));
    expect(ring.encodeIndication({ kind: 'exit_delay', seconds: 600 })).toEqual(write(18, 7, 255));
  });

  it('plays the code-rejected tone and the bypass-required message', () => {
    expect(ring.encodeIndication({ kind: 'code_rejected' })).toEqual(write(9, 1, 1));
    expect(ring.encodeIndication({ kind: 'bypass_required' })).toEqual(write(16, 1, 1));
  });

  it.each([
    ['double_beep', 96],
    ['guitar', 97],
    ['wind_chimes', 98],
    ['bing_bong', 99],
    ['doorbell', 100],
  ])('plays chime %s on indicator %i with the volume as the sound level', (sound, indicator) => {
    expect(ring.encodeIndication({ kind: 'chime', sound, volume: 40 })).toEqual(write(indicator, 9, 40));
  });

  it('uses a default volume and clamps an out-of-range one', () => {
    expect(ring.encodeIndication({ kind: 'chime', sound: 'doorbell' })).toEqual(write(100, 9, 60));
    expect(ring.encodeIndication({ kind: 'chime', sound: 'doorbell', volume: 500 })).toEqual(write(100, 9, 99));
  });

  it('writes nothing for an unknown chime sound', () => {
    expect(ring.encodeIndication({ kind: 'chime', sound: 'kazoo' })).toEqual([]);
  });
});
