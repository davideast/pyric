export interface EventHistoryLimits {
  maxEvents: number;
  maxBytes: number;
}

const utf8 = new TextEncoder();

export function encodedBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    const hasBuffer = typeof Buffer === 'function';
    return hasBuffer ? Buffer.byteLength(json) : utf8.encode(json).byteLength;
  }
  catch { return Infinity; }
}

