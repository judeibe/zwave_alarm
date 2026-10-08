import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../config/logger.js';
import type { KeypadAdapter } from './keypad.js';
import type { KeypadAdapterRegistry } from './keypad-registry.js';

const logger = createLogger('keypads/discovery');

/** An adapter module is any `<name>.adapter.ts` (or compiled `.js`) whose default export is a KeypadAdapter. */
const ADAPTER_FILE = /\.adapter\.(ts|js)$/;

function isKeypadAdapter(value: unknown): value is KeypadAdapter {
  const candidate = value as Partial<KeypadAdapter> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    typeof candidate.supports === 'function' &&
    typeof candidate.decodeInput === 'function' &&
    typeof candidate.encodeIndication === 'function'
  );
}

/**
 * Registers every adapter module found in `directory`. This is what keeps the system open for
 * extension: a new keypad is one new `*.adapter.ts` file dropped into the adapters directory, with
 * no existing file edited to list it.
 *
 * A module that fails to load, or whose default export isn't an adapter, is logged and skipped so
 * one broken adapter can't stop the others (or the alarm itself) from starting.
 */
export async function discoverKeypadAdapters(directory: string, registry: KeypadAdapterRegistry): Promise<void> {
  const files = readdirSync(directory)
    .filter((file) => ADAPTER_FILE.test(file))
    .sort();

  for (const file of files) {
    try {
      const module = (await import(pathToFileURL(join(directory, file)).href)) as { default?: unknown };
      if (!isKeypadAdapter(module.default)) {
        logger.warn('adapter module has no valid default export, skipping', { file });
        continue;
      }
      registry.register(module.default);
      logger.info('registered keypad adapter', { file, adapterId: module.default.id });
    } catch (err) {
      logger.error('failed to load keypad adapter, skipping', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
