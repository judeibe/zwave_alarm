/**
 * The Z-Wave devices the alarm accepts as sensors: the Ring Alarm line plus the third-party smoke/CO alarms Ring
 * lists as compatible. Keyed on the manufacturer id, product type and product id a node reports from its
 * interview (the same ids zwave-js's device database uses), so a node is matched by what it is, never by its name.
 * Locks and keypads are recognised by their own modules (`locks/schlage.ts`, `keypads/adapters`).
 */
import type { SensorAlarmKind, SensorCategory, SensorKind } from '../db/repositories/sensor-repository.js';

export const RING_MANUFACTURER_ID = 0x0346;
/** First Alert / BRK Brands, whose Z-Wave smoke and CO alarms Ring Alarm supports. */
export const FIRST_ALERT_MANUFACTURER_ID = 0x0138;

export interface SupportedDevice {
  brand: 'Ring' | 'First Alert';
  model: string;
  manufacturerId: number;
  productType: number;
  productId: number;
  /** What the node is, which decides how a new entry is pre-filled. */
  deviceType: 'contact' | 'motion' | 'glass_break' | 'flood_freeze' | 'smoke_co' | 'range_extender' | 'outdoor_contact';
  /** Null for devices that are not sensors (a range extender only relays). */
  category: SensorCategory | null;
  alarmKind?: SensorAlarmKind;
  suggestedSensorKind: SensorKind;
}

interface Family {
  brand: SupportedDevice['brand'];
  manufacturerId: number;
  model: string;
  deviceType: SupportedDevice['deviceType'];
  category: SensorCategory | null;
  alarmKind?: SensorAlarmKind;
  suggestedSensorKind: SensorKind;
  /** [productType, productId] pairs. */
  ids: ReadonlyArray<readonly [number, number]>;
}

const ring = (f: Omit<Family, 'brand' | 'manufacturerId'>): Family => ({ brand: 'Ring', manufacturerId: RING_MANUFACTURER_ID, ...f });
const firstAlert = (f: Omit<Family, 'brand' | 'manufacturerId'>): Family => ({ brand: 'First Alert', manufacturerId: FIRST_ALERT_MANUFACTURER_ID, ...f });

const FAMILIES: readonly Family[] = [
  ring({ model: 'Ring Alarm Contact Sensor (1st gen)', deviceType: 'contact', category: 'intrusion', suggestedSensorKind: 'door', ids: [[0x0201, 0x0201], [0x0201, 0x0202]] }),
  ring({ model: 'Ring Alarm Contact Sensor (2nd gen)', deviceType: 'contact', category: 'intrusion', suggestedSensorKind: 'door', ids: [[0x0201, 0x0301], [0x0201, 0x0401], [0x0201, 0x0601]] }),
  ring({ model: 'Ring Alarm Outdoor Contact Sensor', deviceType: 'outdoor_contact', category: 'intrusion', suggestedSensorKind: 'door', ids: [[0x0c01, 0x0301], [0x0c01, 0x0401]] }),
  ring({ model: 'Ring Alarm Motion Detector (1st gen)', deviceType: 'motion', category: 'intrusion', suggestedSensorKind: 'interior', ids: [[0x0301, 0x0201], [0x0301, 0x0202]] }),
  ring({ model: 'Ring Alarm Motion Detector (2nd gen)', deviceType: 'motion', category: 'intrusion', suggestedSensorKind: 'interior', ids: [[0x0301, 0x0301], [0x0301, 0x0401]] }),
  ring({ model: 'Ring Alarm Glass Break Sensor', deviceType: 'glass_break', category: 'intrusion', suggestedSensorKind: 'window', ids: [[0x0a01, 0x0301], [0x0a01, 0x0401]] }),
  ring({ model: 'Ring Alarm Flood & Freeze Sensor', deviceType: 'flood_freeze', category: 'life-safety', alarmKind: 'FLOOD_FREEZE', suggestedSensorKind: 'interior', ids: [[0x0501, 0x0101]] }),
  ring({ model: 'Ring Alarm Smoke & CO Listener', deviceType: 'smoke_co', category: 'life-safety', alarmKind: 'SMOKE', suggestedSensorKind: 'interior', ids: [[0x0601, 0x0101]] }),
  ring({ model: 'Ring Alarm Range Extender (1st gen)', deviceType: 'range_extender', category: null, suggestedSensorKind: 'interior', ids: [[0x0401, 0x0101], [0x0401, 0x0102], [0x0401, 0x0202]] }),
  ring({ model: 'Ring Alarm Range Extender (2nd gen)', deviceType: 'range_extender', category: null, suggestedSensorKind: 'interior', ids: [[0x0401, 0x0301], [0x0401, 0x0401]] }),
  firstAlert({ model: 'First Alert ZSMOKE Smoke Alarm', deviceType: 'smoke_co', category: 'life-safety', alarmKind: 'SMOKE', suggestedSensorKind: 'interior', ids: [[0x0001, 0x0001]] }),
  firstAlert({ model: 'First Alert ZCOMBO Smoke & CO Alarm', deviceType: 'smoke_co', category: 'life-safety', alarmKind: 'SMOKE', suggestedSensorKind: 'interior', ids: [[0x0001, 0x0002], [0x000c, 0x0001], [0x0001, 0x0003]] }),
  firstAlert({ model: 'First Alert SMCO400 Smoke & CO Alarm', deviceType: 'smoke_co', category: 'life-safety', alarmKind: 'SMOKE', suggestedSensorKind: 'interior', ids: [[0x0001, 0x0058]] }),
];

export const SUPPORTED_DEVICES: readonly SupportedDevice[] = FAMILIES.flatMap(({ ids, ...family }) =>
  ids.map(([productType, productId]) => ({ ...family, productType, productId })),
);

export interface NodeIds {
  manufacturerId: number | undefined;
  productType: number | undefined;
  productId: number | undefined;
}

/** The catalog entry for a node's interview ids, or undefined for anything Ring does not support. */
export function identifySupportedDevice(ids: NodeIds): SupportedDevice | undefined {
  return SUPPORTED_DEVICES.find(
    (device) => device.manufacturerId === ids.manufacturerId && device.productType === ids.productType && device.productId === ids.productId,
  );
}
