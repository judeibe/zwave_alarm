import type { KeypadAdapter, NodeIdentity } from './keypad.js';

/**
 * The set of keypad adapters this process knows about. Adding support for a new keypad means
 * registering one more adapter here (see `discoverKeypadAdapters`); nothing that consumes the
 * registry changes.
 */
export class KeypadAdapterRegistry {
  private readonly adapters: KeypadAdapter[] = [];

  register(adapter: KeypadAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`A keypad adapter with id "${adapter.id}" is already registered`);
    }
    this.adapters.push(adapter);
  }

  /** The first registered adapter that recognises the node, or undefined if it isn't a known keypad. */
  resolve(identity: NodeIdentity): KeypadAdapter | undefined {
    return this.adapters.find((adapter) => adapter.supports(identity));
  }

  list(): readonly KeypadAdapter[] {
    return this.adapters;
  }
}
