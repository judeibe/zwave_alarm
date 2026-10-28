import { describe, expect, it } from 'vitest';
import { identifySupportedDevice, SUPPORTED_DEVICES } from '../../src/zwave/supported-devices.js';

describe('supported devices', () => {
  it('matches a Ring contact sensor and a First Alert smoke alarm by their interview ids', () => {
    expect(identifySupportedDevice({ manufacturerId: 0x0346, productType: 0x0201, productId: 0x0301 })).toMatchObject({ deviceType: 'contact', category: 'intrusion' });
    expect(identifySupportedDevice({ manufacturerId: 0x0138, productType: 0x0001, productId: 0x0002 })).toMatchObject({ deviceType: 'smoke_co', category: 'life-safety' });
  });

  it('rejects unknown ids and nodes that have not been interviewed', () => {
    expect(identifySupportedDevice({ manufacturerId: 0x0086, productType: 0x0002, productId: 0x0059 })).toBeUndefined();
    expect(identifySupportedDevice({ manufacturerId: 0x0346, productType: 0x0201, productId: 0xffff })).toBeUndefined();
    expect(identifySupportedDevice({ manufacturerId: undefined, productType: undefined, productId: undefined })).toBeUndefined();
  });

  it('has no duplicate id triples', () => {
    const keys = SUPPORTED_DEVICES.map((d) => `${d.manufacturerId}:${d.productType}:${d.productId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
