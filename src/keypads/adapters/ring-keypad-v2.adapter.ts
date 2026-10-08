import { CommandClasses } from '@zwave-js/core';
import type {
  KeypadAdapter,
  KeypadIndication,
  KeypadInput,
  NodeIdentity,
  RawNotification,
  ValueWrite,
} from '../keypad.js';

/**
 * Ring Alarm Keypad (2nd gen), Z-Wave. Behaviour per the community notes at
 * https://github.com/ImSorryButWho/HomeAssistantNotes/blob/main/RingKeypadV2.md, cross-checked
 * against zwave-js's device database (config/devices/0x0346/keypad_v2.json) and its
 * `EntryControlEventTypes` enum.
 *
 * Input arrives as Entry Control CC notifications; lights and sounds are driven through the
 * Indicator CC. The keypad must be included with S2 security for either to work.
 */

const RING_MANUFACTURER_ID = 0x0346;
const KEYPAD_V2_PRODUCT_TYPE = 0x0101;
const KEYPAD_V2_PRODUCT_IDS: readonly number[] = [0x0301, 0x0401];

/** Entry Control event types the keypad produces (zwave-js `EntryControlEventTypes`). */
const ENTRY_EVENT = {
  caching: 0,
  cachedKeys: 1,
  enter: 2,
  disarm: 3,
  armAway: 5,
  armHome: 6,
  fire: 16,
  police: 17,
  medical: 19,
  cancel: 25,
} as const;

/** Indicator CC ids (zwave-js `property`) that visibly or audibly do something on this keypad. */
const INDICATOR = {
  disarmed: 2,
  codeRejected: 9,
  armedHome: 10,
  armedAway: 11,
  burglarAlarm: 13,
  bypassRequired: 16,
  entryDelay: 17,
  exitDelay: 18,
} as const;

/** Indicator property ids (zwave-js `propertyKey`). */
const PROPERTY = { onOff: 1, timeoutSeconds: 7, soundLevel: 9 } as const;

/** Brightness (0-99) the mode lights are set to when switching mode. */
const MODE_BRIGHTNESS = 99;
const MAX_INDICATOR_SECONDS = 255;
const MAX_VOLUME = 99;
const DEFAULT_CHIME_VOLUME = 60;

const CHIME_INDICATORS: Readonly<Record<string, number>> = {
  double_beep: 96,
  guitar: 97,
  wind_chimes: 98,
  bing_bong: 99,
  doorbell: 100,
};

const MODE_INDICATORS = {
  disarmed: INDICATOR.disarmed,
  armed_home: INDICATOR.armedHome,
  armed_away: INDICATOR.armedAway,
} as const;

function indicatorWrite(property: number, propertyKey: number, value: number): ValueWrite {
  return { commandClass: CommandClasses.Indicator, endpoint: 0, property, propertyKey, value };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The code the user typed, if any. zwave-js reports it as an ASCII string, or raw bytes for other data types. */
function readCode(eventData: unknown): string | undefined {
  const text =
    typeof eventData === 'string'
      ? eventData
      : eventData instanceof Uint8Array
        ? Buffer.from(eventData).toString('latin1')
        : '';
  return text === '' ? undefined : text;
}

export const ringKeypadV2Adapter: KeypadAdapter = {
  id: 'ring-keypad-v2',
  label: 'Ring Keypad v2',
  capabilities: ['arm_disarm', 'emergency', 'indicators', 'chime'],
  chimeSounds: Object.keys(CHIME_INDICATORS),

  supports(identity: NodeIdentity): boolean {
    return (
      identity.manufacturerId === RING_MANUFACTURER_ID &&
      identity.productType === KEYPAD_V2_PRODUCT_TYPE &&
      KEYPAD_V2_PRODUCT_IDS.includes(identity.productId)
    );
  },

  decodeInput({ commandClass, args }: RawNotification): KeypadInput | null {
    if (commandClass !== CommandClasses['Entry Control']) {
      return null;
    }
    const code = readCode(args.eventData);

    switch (args.eventType) {
      case ENTRY_EVENT.enter:
        // Enter with no digits typed carries nothing to check.
        return code === undefined ? null : { kind: 'code_entered', code };
      case ENTRY_EVENT.disarm:
        return { kind: 'disarm', ...(code !== undefined && { code }) };
      case ENTRY_EVENT.armAway:
        return { kind: 'arm_away', ...(code !== undefined && { code }) };
      case ENTRY_EVENT.armHome:
        return { kind: 'arm_home', ...(code !== undefined && { code }) };
      case ENTRY_EVENT.fire:
        return { kind: 'emergency', emergency: 'fire' };
      case ENTRY_EVENT.police:
        return { kind: 'emergency', emergency: 'police' };
      case ENTRY_EVENT.medical:
        return { kind: 'emergency', emergency: 'medical' };
      case ENTRY_EVENT.cancel:
        return { kind: 'cancel' };
      default:
        // caching / cachedKeys (a code is being typed or timed out) and anything unknown.
        return null;
    }
  },

  encodeIndication(indication: KeypadIndication): ValueWrite[] {
    switch (indication.kind) {
      case 'mode':
        return [indicatorWrite(MODE_INDICATORS[indication.mode], PROPERTY.onOff, MODE_BRIGHTNESS)];
      case 'alarm':
        return [indicatorWrite(INDICATOR.burglarAlarm, PROPERTY.onOff, 1)];
      case 'entry_delay':
        return [indicatorWrite(INDICATOR.entryDelay, PROPERTY.timeoutSeconds, clamp(indication.seconds, 1, MAX_INDICATOR_SECONDS))];
      case 'exit_delay':
        return [indicatorWrite(INDICATOR.exitDelay, PROPERTY.timeoutSeconds, clamp(indication.seconds, 1, MAX_INDICATOR_SECONDS))];
      case 'code_rejected':
        return [indicatorWrite(INDICATOR.codeRejected, PROPERTY.onOff, 1)];
      case 'bypass_required':
        return [indicatorWrite(INDICATOR.bypassRequired, PROPERTY.onOff, 1)];
      case 'chime': {
        const indicator = CHIME_INDICATORS[indication.sound];
        if (indicator === undefined) {
          return [];
        }
        return [indicatorWrite(indicator, PROPERTY.soundLevel, clamp(indication.volume ?? DEFAULT_CHIME_VOLUME, 0, MAX_VOLUME))];
      }
    }
  },
};

export default ringKeypadV2Adapter;
