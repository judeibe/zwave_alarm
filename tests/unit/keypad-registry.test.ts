import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverKeypadAdapters } from '../../src/keypads/discovery.js';
import { KeypadAdapterRegistry } from '../../src/keypads/keypad-registry.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';
import { acmePadAdapter } from './fixtures/keypad-adapters/acme-pad.adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const RING = { manufacturerId: 0x0346, productType: 0x0101, productId: 0x0301 };
const ACME = { manufacturerId: 0xac3e, productType: 1, productId: 2 };

describe('KeypadAdapterRegistry', () => {
  it('resolves a node to the adapter that recognises it', () => {
    const registry = new KeypadAdapterRegistry();
    registry.register(ringKeypadV2Adapter);
    registry.register(acmePadAdapter);

    expect(registry.resolve(RING)).toBe(ringKeypadV2Adapter);
    expect(registry.resolve(ACME)).toBe(acmePadAdapter);
    expect(registry.list()).toHaveLength(2);
  });

  it('resolves nothing for a node that is not a known keypad', () => {
    const registry = new KeypadAdapterRegistry();
    registry.register(ringKeypadV2Adapter);
    expect(registry.resolve({ manufacturerId: 1, productType: 2, productId: 3 })).toBeUndefined();
  });

  it('refuses two adapters with the same id', () => {
    const registry = new KeypadAdapterRegistry();
    registry.register(ringKeypadV2Adapter);
    expect(() => registry.register(ringKeypadV2Adapter)).toThrow(/already registered/);
  });
});

describe('discoverKeypadAdapters', () => {
  it('registers the Ring adapter from the real adapters directory', async () => {
    const registry = new KeypadAdapterRegistry();
    await discoverKeypadAdapters(join(here, '..', '..', 'src', 'keypads', 'adapters'), registry);

    expect(registry.list().map((adapter) => adapter.id)).toEqual(['ring-keypad-v2']);
    expect(registry.resolve(RING)?.id).toBe('ring-keypad-v2');
  });

  it('picks up a second keypad just by its file being in the directory (open/closed)', async () => {
    // The fixture directory holds only acme-pad.adapter.ts. Nothing in src/ was edited to know about
    // it: pointing discovery at a directory is the whole of "adding a keypad".
    const registry = new KeypadAdapterRegistry();
    await discoverKeypadAdapters(join(here, 'fixtures', 'keypad-adapters'), registry);

    expect(registry.list().map((adapter) => adapter.id)).toEqual(['acme-pad']);
    expect(registry.resolve(ACME)?.id).toBe('acme-pad');
    expect(registry.resolve(RING)).toBeUndefined();
  });

  it('skips a module that is not a valid adapter and keeps loading the rest', async () => {
    const registry = new KeypadAdapterRegistry();
    await discoverKeypadAdapters(join(here, 'fixtures', 'keypad-adapters-mixed'), registry);

    expect(registry.list().map((adapter) => adapter.id)).toEqual(['acme-pad']);
  });
});
