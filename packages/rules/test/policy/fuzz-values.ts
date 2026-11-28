// Adversarial input corpus, random Rules value generators, and deterministic shrinker
// for differential compiler fuzzing across interpreter, ES module, and database targets.
import type { SeededRng } from './fuzz-prng.js';

export const EDGE_NUMBERS: readonly number[] = [
  0,
  -0.0,
  1,
  -1,
  2,
  -2,
  7,
  42,
  -42,
  0.5,
  -0.5,
  1.5,
  -1.5,
  1.0,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1, // 9007199254740992 (2^53, Rules float)
  -(Number.MAX_SAFE_INTEGER + 1),
  2 ** 31 - 1,
  -(2 ** 31),
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

export const INT64_BOUNDARY_BIGINTS: readonly bigint[] = [
  9223372036854775807n,
  -9223372036854775808n,
  9007199254740991n,
  9007199254740992n,
  9007199254740993n,
  -9007199254740991n,
  -9007199254740992n,
  -9007199254740993n,
];

export const SAFE_INTEGERS: readonly number[] = [
  0, 1, -1, 2, -2, 3, 5, 7, 10, -10, 100, -100,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
];

export const EDGE_STRINGS: readonly string[] = [
  '',
  'a',
  'b',
  'ab',
  'A',
  '0',
  '-0',
  '1',
  'true',
  'null',
  'image/png',
  'audio/wav',
  'text/plain',
  'users/alice',
  'a_b_c',
  '  trim  ',
];

export const SAFE_MAP_KEYS: readonly string[] = ['a', 'b', 'c', 'x', 'y', 'n', 'flag', 'tag'];

// Pure 7-bit ASCII escaped Unicode, astral, and lone-surrogate strings for RE2/string parity.
export const UNICODE_EDGE_STRINGS: readonly string[] = [
  '',
  'a',
  'ABC',
  'abc',
  'a\nb',
  'a\tb\u000bc',
  '\u000b',
  '\u000c',
  '\u00a0',
  '\u0000',
  '\u00c5',
  '\u00e5',
  '\u212b',
  '\u212a',
  '\u017f',
  '\u03a3',
  '\u03c2',
  '\u03c3',
  '\u00df',
  '\u1e9e',
  '\u00e9',
  '\u00c9',
  '\u03a9',
  '\u2126',
  '\u0412',
  '\u0432',
  '\u1c80',
  '\uD83D\uDE00',
  'a\uD83D\uDE00b',
  '\uD83D\uDE00\uD83D\uDE01',
  '\uD83D\uDE00\n\uD83D\uDE01',
  '\uD800',
  '\uDC00',
  'a\uD800b',
  '\uFF00',
];

export const STORAGE_EDGE_MIMES: readonly string[] = [
  'audio/wav',
  'audio/ogg',
  'audio/mpeg',
  'AUDIO/wav',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'text/plain',
  'text/plain; charset=utf-8',
  'application/octet-stream',
  'application/vnd.api+json',
  'text/\u000bplain',
  '',
];

export const STORAGE_EDGE_PATHS: readonly string[] = [
  'items/obj1',
  'items/sub/clip-01.wav',
  'items/a/b/c/avatar.v2.png',
  'items/users/alice/doc_final.txt',
  'items/nested/file.with.dots.jpeg',
  'items/space name/report 1.pdf',
  'items/encoded/%2e%2e/safe.bin',
  'items/cafe-\u00e9/note.txt',
];

export const HOSTILE_KEYS: readonly string[] = [
  'constructor',
  '__proto__',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
];

export interface ValueGenOptions {
  readonly maxDepth?: number;
  readonly maxListLength?: number;
  readonly maxMapKeys?: number;
  readonly allowNonFinite?: boolean;
  readonly allowFloats?: boolean;
  readonly safeIntegersOnly?: boolean;
  readonly allowNull?: boolean;
  readonly keys?: readonly string[];
}

export function generateScalar(rng: SeededRng, opts: ValueGenOptions = {}): unknown {
  const {
    allowNonFinite = true,
    allowFloats = true,
    safeIntegersOnly = false,
    allowNull = true,
  } = opts;
  const kind = rng.weighted([
    [4, 'int'],
    [allowFloats && !safeIntegersOnly ? 2 : 0, 'float'],
    [2, 'bool'],
    [2, 'string'],
    [allowNull ? 1 : 0, 'null'],
  ]);
  switch (kind) {
    case 'int':
      return rng.bool(0.5) ? rng.pick(SAFE_INTEGERS) : rng.int(-20, 20);
    case 'float': {
      const pool = allowNonFinite
        ? EDGE_NUMBERS
        : EDGE_NUMBERS.filter((n) => Number.isFinite(n));
      return rng.pick(pool);
    }
    case 'bool':
      return rng.bool();
    case 'string':
      return rng.pick(EDGE_STRINGS);
    case 'null':
      return null;
  }
}

export function generateValue(rng: SeededRng, opts: ValueGenOptions = {}, depth = 0): unknown {
  const maxDepth = opts.maxDepth ?? 2;
  const maxListLength = opts.maxListLength ?? 4;
  const maxMapKeys = opts.maxMapKeys ?? 4;
  if (depth >= maxDepth) return generateScalar(rng, opts);
  const kind = rng.weighted([
    [5, 'scalar'],
    [2, 'list'],
    [2, 'map'],
  ]);
  if (kind === 'scalar') return generateScalar(rng, opts);
  if (kind === 'list') {
    const len = rng.int(0, maxListLength);
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) out.push(generateValue(rng, opts, depth + 1));
    return out;
  }
  const keyPool = opts.keys ?? SAFE_MAP_KEYS;
  const count = rng.int(0, Math.min(maxMapKeys, keyPool.length));
  const map: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const key = rng.pick(keyPool);
    map[key] = generateValue(rng, opts, depth + 1);
  }
  return map;
}

export interface HostilePayload {
  readonly label: string;
  readonly build: () => { payload: unknown; wasGetterInvoked: () => boolean };
}

// Hostile host inputs that must be rejected without invoking getters or leaking prototypes.
export function hostilePayloads(): HostilePayload[] {
  return [
    {
      label: 'top-level-getter',
      build() {
        let invoked = false;
        const payload = {};
        Object.defineProperty(payload, 'a', {
          enumerable: true,
          get() {
            invoked = true;
            return 1;
          },
        });
        return { payload, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'nested-array-getter',
      build() {
        let invoked = false;
        const payload: unknown[] = [1, 2];
        Object.defineProperty(payload, 0, {
          enumerable: true,
          get() {
            invoked = true;
            return 99;
          },
        });
        return { payload, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'custom-class-prototype',
      build() {
        class CustomBox {
          x = 1;
        }
        return { payload: new CustomBox(), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'date-instance',
      build() {
        return { payload: new Date(0), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'cyclic-array',
      build() {
        const arr: unknown[] = [];
        arr.push(arr);
        return { payload: arr, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'cyclic-object',
      build() {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        return { payload: obj, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'deep-nesting-over-limit',
      build() {
        let node: unknown = 1;
        for (let i = 0; i < 40; i++) node = { next: node };
        return { payload: node, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'map-instance',
      build() {
        return { payload: new Map([['a', 1]]), wasGetterInvoked: () => false };
      },
    },
    {
      label: 'non-enumerable-getter',
      build() {
        let invoked = false;
        const payload: Record<string, unknown> = { a: 1 };
        Object.defineProperty(payload, 'secret', {
          enumerable: false,
          get() {
            invoked = true;
            return 42;
          },
        });
        return { payload, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'symbol-key-getter',
      build() {
        let invoked = false;
        const payload: Record<PropertyKey, unknown> = { a: 1 };
        Object.defineProperty(payload, Symbol('trap'), {
          enumerable: true,
          get() {
            invoked = true;
            return 7;
          },
        });
        return { payload, wasGetterInvoked: () => invoked };
      },
    },
    {
      label: 'array-subclass',
      build() {
        class SubArray extends Array<number> {}
        const arr = new SubArray(1, 2, 3);
        return { payload: arr, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'sparse-array',
      build() {
        const arr: unknown[] = [];
        arr[2] = 1;
        return { payload: arr, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'own-proto-key',
      build() {
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, '__proto__', { value: 1, enumerable: true });
        return { payload, wasGetterInvoked: () => false };
      },
    },
    {
      label: 'own-constructor-key',
      build() {
        const payload: Record<string, unknown> = {};
        Object.defineProperty(payload, 'constructor', { value: 1, enumerable: true });
        return { payload, wasGetterInvoked: () => false };
      },
    },
  ];
}

// Generic deterministic shrinker for counterexamples (inputs and/or AST terms).
export interface ShrinkResult<T> {
  readonly value: T;
  readonly steps: number;
}

export function shrinkCounterexample<T>(
  initial: T,
  candidates: (current: T) => Iterable<T>,
  stillFails: (candidate: T) => boolean,
  maxSteps = 200,
): ShrinkResult<T> {
  let current = initial;
  let steps = 0;
  let improved = true;
  while (improved && steps < maxSteps) {
    improved = false;
    for (const candidate of candidates(current)) {
      if (steps >= maxSteps) break;
      steps++;
      if (stillFails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return { value: current, steps };
}

// Structural value shrinker producing smaller plain JSON-like values in deterministic order.
export function* shrinkValue(value: unknown): Generator<unknown> {
  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      yield 0;
      return;
    }
    if (value === 0) {
      if (Object.is(value, -0)) yield 0;
      return;
    }
    yield 0;
    if (value < 0) yield -value;
    const half = Math.trunc(value / 2);
    if (half !== 0 && half !== value) yield half;
    if (Number.isInteger(value) && Math.abs(value) > 1) {
      yield value > 0 ? value - 1 : value + 1;
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0) return;
    yield '';
    if (value.length > 1) {
      yield value.slice(0, Math.floor(value.length / 2));
      yield value.slice(1);
      yield value.slice(0, -1);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0) {
      yield [];
      for (let i = 0; i < value.length; i++) {
        yield [...value.slice(0, i), ...value.slice(i + 1)];
      }
      for (let i = 0; i < value.length; i++) {
        for (const shrunk of shrinkValue(value[i])) {
          const next = [...value];
          next[i] = shrunk;
          yield next;
        }
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 0) {
      yield {};
      for (const k of keys) {
        const copy: Record<string, unknown> = {};
        for (const other of keys) {
          if (other !== k) copy[other] = record[other];
        }
        yield copy;
      }
      for (const k of keys) {
        for (const shrunk of shrinkValue(record[k])) {
          yield { ...record, [k]: shrunk };
        }
      }
    }
  }
}
