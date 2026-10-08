import type { KeypadAdapter } from '../../../../src/keypads/keypad.js';

/**
 * A second, made-up keypad used to prove the extension point: this file is the *only* thing that
 * was added to support it. It lives in a fixture directory that discovery is pointed at, exactly as
 * a real new adapter would sit beside `ring-keypad-v2.adapter.ts`.
 */
export const acmePadAdapter: KeypadAdapter = {
  id: 'acme-pad',
  label: 'Acme Pad',
  capabilities: ['arm_disarm'],
  chimeSounds: [],

  supports: ({ manufacturerId, productType, productId }) =>
    manufacturerId === 0xac3e && productType === 1 && productId === 2,

  // Acme reports a whole PIN in a single notification.
  decodeInput: ({ commandClass, args }) =>
    commandClass === 0x70 && typeof args.pin === 'string' ? { kind: 'disarm', code: args.pin } : null,

  encodeIndication: (indication) =>
    indication.kind === 'mode'
      ? [{ commandClass: 0x71, endpoint: 0, property: 'led', value: indication.mode === 'disarmed' ? 0 : 1 }]
      : [],
};

export default acmePadAdapter;
