/**
 * Deterministic generators for Firestore `ValueSpec`, `SetMode`, and
 * `UpdateEntry` payloads, covering scalars, special IEEE-754 numbers, `Bytes`,
 * `GeoPoint`, `Timestamp`, `DocumentReference`, field sentinels, reserved map
 * keys, and map key-order permutations.
 */

import type { Prng } from './prng.js';
import type {
  FieldPathSpec,
  SetMode,
  UpdateEntry,
  ValueSpec,
} from './sequence.js';

export const DOC_PATHS: readonly string[] = [
  'users/alice',
  'users/bob',
  'users/carol',
  'items/i1',
  'items/i2',
  'items/i3',
  'items/i4',
  'items/i5',
  'orgs/o1',
  'orgs/o2',
  'orgs/o1/docs/d1',
  'orgs/o1/docs/d2',
  'orgs/o2/docs/d1',
  'rooms/r1/items/i1',
  'rooms/r1/items/i2',
  'rooms/r2/items/i3',
  'metrics/m1',
  'metrics/m2',
];

export const TAG_POOL: readonly string[] = ['alpha', 'beta', 'gamma', 'delta', 'urgent'];
export const LABEL_POOL: readonly string[] = ['draft', 'active', 'archived', 'pinned', ''];

const RESERVED_KEYS: readonly string[] = [
  'type',
  '__type',
  '__type__',
  'value',
  'fields',
  'seconds',
  'latitude',
  '$t',
];

const UPDATE_FIELD_POOL: readonly FieldPathSpec[] = [
  'n',
  'label',
  'flag',
  'tags',
  'meta.count',
  'meta.note',
  { segments: ['meta', 'nested', 'score'] },
  { segments: ['meta.v1', 'flag'] },
  { segments: ['type'] },
];

export function randomScalarValue(rng: Prng): ValueSpec {
  const kind = rng.int(0, 9);
  if (kind === 0) return null;
  if (kind === 1) return rng.chance(0.5);
  if (kind === 2) return rng.pick([-10, -1, 0, 1, 2, 3, 5, 10, 42]);
  if (kind === 3) return rng.pick([-2.5, 0.5, 1.25, 3.75, 99.5]);
  if (kind === 4) {
    return { $num: rng.pick(['-0', 'NaN', 'Infinity', '-Infinity'] as const) };
  }
  if (kind === 5) return rng.pick(LABEL_POOL);
  if (kind === 6) {
    const length = rng.int(0, 5);
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) {
      bytes.push(rng.int(0, 255));
    }
    return { $bytes: bytes };
  }
  if (kind === 7) {
    const lat = rng.pick([-45, -12.5, 0, 37.7749, 51.5]);
    const lng = rng.pick([-122.4194, -0.1278, 0, 139.6917]);
    return { $geo: [lat, lng] };
  }
  if (kind === 8) {
    const sec = rng.pick([0, 1_000, 1_600_000_000, 1_650_000_123, 1_700_000_000]);
    const nano = rng.pick([0, 123_000_000, 999_999_999]);
    return { $ts: [sec, nano] };
  }
  return {
    $ref: {
      path: rng.pick(DOC_PATHS),
      db: rng.pick([0, 1, 2]),
    },
  };
}

function randomArrayElement(rng: Prng): ValueSpec {
  if (rng.chance(0.25)) {
    return {
      $map: [
        ['k', rng.pick(TAG_POOL)],
        ['v', rng.int(0, 5)],
      ],
    };
  }
  return randomScalarValue(rng);
}

function randomStoredValue(rng: Prng, depth: number): ValueSpec {
  if (depth >= 2 || rng.chance(0.65)) {
    return randomScalarValue(rng);
  }
  if (rng.chance(0.45)) {
    const len = rng.int(0, 3);
    const items: ValueSpec[] = [];
    for (let i = 0; i < len; i++) {
      items.push(randomArrayElement(rng));
    }
    return { $array: items };
  }
  const keyPool = rng.shuffle(['a', 'b', 'c', rng.pick(RESERVED_KEYS)]);
  const count = rng.int(1, 3);
  const entries: Array<[string, ValueSpec]> = [];
  for (let i = 0; i < count; i++) {
    const key = keyPool[i];
    if (key !== undefined) {
      entries.push([key, randomStoredValue(rng, depth + 1)]);
    }
  }
  return { $map: entries };
}

export function randomWriteFieldValue(rng: Prng, allowDelete: boolean): ValueSpec {
  if (rng.chance(0.32)) {
    const sentinelKind = rng.int(0, 4);
    if (sentinelKind === 0 && allowDelete) {
      return { $delete: true };
    }
    if (sentinelKind === 1) {
      return { $serverTs: true };
    }
    if (sentinelKind === 2) {
      return { $inc: rng.pick([-3, -1, 0, 1, 2, 5, 1.5]) };
    }
    if (sentinelKind === 3) {
      return { $union: [rng.pick(TAG_POOL), rng.pick([1, 2, null])] };
    }
    return { $remove: [rng.pick(TAG_POOL), 1] };
  }
  return randomStoredValue(rng, 0);
}

export function randomDocumentData(rng: Prng, allowDeleteSentinel: boolean): ValueSpec {
  if (rng.chance(0.18)) {
    let pairOrder: Array<[string, ValueSpec]> = [['b', 2], ['a', 1]];
    if (rng.chance(0.5)) {
      pairOrder = [['a', 1], ['b', 2]];
    }
    return {
      $map: [
        ['n', 1],
        ['flag', true],
        ['meta', { $map: pairOrder }],
      ],
    };
  }

  let nValue: ValueSpec = rng.int(0, 10);
  if (!rng.chance(0.8)) {
    nValue = randomWriteFieldValue(rng, allowDeleteSentinel);
  }
  let tagsValue: ValueSpec = { $array: [rng.pick(TAG_POOL), rng.pick(TAG_POOL)] };
  if (!rng.chance(0.75)) {
    tagsValue = randomWriteFieldValue(rng, allowDeleteSentinel);
  }
  let stampedValue: ValueSpec = { $ts: [1_650_000_000, 0] };
  if (rng.chance(0.4)) {
    stampedValue = { $serverTs: true };
  }

  const entries: Array<[string, ValueSpec]> = [
    ['n', nValue],
    ['label', rng.pick(LABEL_POOL)],
    ['flag', rng.chance(0.5)],
    ['tags', tagsValue],
    [
      'meta',
      {
        $map: rng.shuffle([
          ['count', rng.int(0, 8)],
          ['note', rng.pick(TAG_POOL)],
          ['stamped', stampedValue],
        ] as Array<[string, ValueSpec]>),
      },
    ],
  ];

  if (rng.chance(0.4)) {
    entries.push([rng.pick(RESERVED_KEYS), randomStoredValue(rng, 1)]);
  }
  if (rng.chance(0.35)) {
    entries.push(['extra', randomWriteFieldValue(rng, allowDeleteSentinel)]);
  }
  return { $map: rng.shuffle(entries) };
}

export function randomSetMode(rng: Prng): SetMode {
  const roll = rng.int(0, 4);
  if (roll <= 1) {
    return { kind: 'replace' };
  }
  if (roll <= 3) {
    return { kind: 'merge' };
  }
  const pool = rng.shuffle([
    'n',
    'label',
    'flag',
    'meta.count',
    { segments: ['meta', 'note'] },
    { segments: ['type'] },
  ] as FieldPathSpec[]);
  return {
    kind: 'mergeFields',
    fields: pool.slice(0, rng.int(1, 3)),
  };
}

export function randomUpdates(rng: Prng): { style: 'object' | 'pairs'; updates: UpdateEntry[] } {
  const style: 'object' | 'pairs' = rng.chance(0.5) ? 'object' : 'pairs';
  const count = rng.int(1, 3);
  let basePool: readonly FieldPathSpec[] = UPDATE_FIELD_POOL;
  if (style === 'object') {
    basePool = ['n', 'label', 'flag', 'tags', 'meta.count', 'meta.note', 'type'];
  }
  const candidates = rng.shuffle(basePool);
  const updates: UpdateEntry[] = [];
  for (let i = 0; i < count; i++) {
    const field = candidates[i];
    if (field !== undefined) {
      let value: ValueSpec = randomWriteFieldValue(rng, true);
      if (field === 'n' && rng.chance(0.6)) {
        if (rng.chance(0.5)) {
          value = rng.int(0, 12);
        } else {
          value = { $inc: rng.pick([1, 2, -1]) };
        }
      }
      updates.push({ field, value });
    }
  }
  return { style, updates };
}
