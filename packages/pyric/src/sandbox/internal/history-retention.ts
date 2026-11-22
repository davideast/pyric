import { stringifyClaimJson } from '@pyric/rules/internal';

export interface EventHistoryLimits {
  maxEvents: number;
  maxBytes: number;
}

const utf8 = new TextEncoder();

export function encodedBytes(value: unknown): number {
  try {
    const json = stringifyClaimJson(value);
    const hasBuffer = typeof Buffer === 'function';
    return hasBuffer ? Buffer.byteLength(json) : utf8.encode(json).byteLength;
  }
  catch (error: unknown) {
    // Unserializable values exceed any finite byte budget.
    void error;
    return Infinity;
  }
}

