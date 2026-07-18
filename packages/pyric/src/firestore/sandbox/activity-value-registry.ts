/**
 * Side-effect-free activity descriptors registered by values Pyric itself
 * constructs. WeakMap lookup never observes an arbitrary operand or Proxy.
 *
 * The store is pinned on `globalThis` under a shared key: registration and
 * lookup must agree even when two copies of this module load in one process
 * (src and dist mix under bun test; a bundler may duplicate the leaf). A
 * per-module WeakMap would silently mark every cross-copy value opaque.
 */
const REGISTRY_KEY = Symbol.for('pyric.firestore.activity-value-registry');
const globalStore = globalThis as { [REGISTRY_KEY]?: WeakMap<object, unknown> };
const descriptors: WeakMap<object, unknown> =
  globalStore[REGISTRY_KEY] ?? (globalStore[REGISTRY_KEY] = new WeakMap());

/** Incremental bounded 128-bit content identity for trusted Pyric-owned values. */
function createDigest(): {
  update(chunk: string | Uint8Array): void;
  finish(): string;
} {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let c = 0x85ebca6b;
  let d = 0xc2b2ae35;
  const byte = (value: number): void => {
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul(b ^ value, 0x85ebca6b);
    c = Math.imul(c ^ value, 0xc2b2ae35);
    d = Math.imul(d ^ value, 0x27d4eb2f);
  };
  return {
    update: (chunk): void => {
      if (typeof chunk === 'string') {
        for (let index = 0; index < chunk.length; index += 1) {
          const code = chunk.charCodeAt(index);
          byte(code & 0xff);
          byte(code >>> 8);
        }
      } else {
        for (const value of chunk) byte(value);
      }
    },
    finish: (): string => [a, b, c, d]
      .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
      .join(''),
  };
}

function digest(...chunks: Array<string | Uint8Array>): string {
  const hasher = createDigest();
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.finish();
}

export function boundedActivityString(value: string): unknown {
  return {
    type: 'string-digest',
    length: value.length,
    digest: digest('string\0', value),
  };
}

/** Build a fixed-size descriptor without exposing the original operand. */
export function boundedActivityIdentity(
  type: string,
  ...chunks: Array<string | Uint8Array>
): unknown {
  return { type: `${type}-digest`, digest: digest(`${type}\0`, ...chunks) };
}

export function boundedActivityBytes(value: Uint8Array): unknown {
  return {
    type: 'bytes-digest',
    length: value.byteLength,
    digest: digest('bytes\0', value),
  };
}

/**
 * Canonicalize a structured-cloned wire value. Callers must use this only at
 * a trusted protocol-decoding seam: unlike activityValue(), this deliberately
 * walks arrays/maps. The digest is fixed-size, so query keys never retain the
 * potentially huge operand tree.
 */
export function trustedWireActivityValue(value: unknown): unknown {
  const hasher = createDigest();
  const push = (...chunks: string[]): void => {
    for (const chunk of chunks) hasher.update(chunk);
  };
  const visit = (entry: unknown): void => {
    if (entry === null) { push('null;'); return; }
    switch (typeof entry) {
      case 'string': push(`s${entry.length}:`, entry, ';'); return;
      case 'number':
        push(`n${Object.is(entry, -0) ? '-0' : String(entry)};`); return;
      case 'boolean': push(entry ? 'b1;' : 'b0;'); return;
      case 'undefined': push('u;'); return;
      case 'bigint': push(`i${entry.toString()};`); return;
      case 'object': break;
      default: push(`x${typeof entry};`); return;
    }
    if (Array.isArray(entry)) {
      push(`a${entry.length}[`);
      for (const item of entry) visit(item);
      push('];');
      return;
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    push(`o${keys.length}{`);
    for (const key of keys) {
      push(`k${key.length}:`, key, '=');
      visit(record[key]);
    }
    push('};');
  };
  visit(value);
  return { type: 'wire-value-digest', digest: hasher.finish() };
}

export function registerActivityValue(value: object, descriptor: unknown): void {
  descriptors.set(value, descriptor);
}

export function registeredActivityValue(value: object): unknown | undefined {
  return descriptors.get(value);
}
