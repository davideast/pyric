/**
 * A seeded generator of RTDB operation sequences across two or three
 * instances. The same seed always yields the same sequence.
 */
import {
  RULES_POOL,
  type JsonValue,
  type ListenEvent,
  type QuerySpec,
  type Sequence,
  type Step,
  type TransactionScript,
  type WriteValue,
} from './sequence.js';

/** mulberry32: a small, fast, seedable PRNG. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Draw {
  constructor(private readonly next: () => number) {}
  float(): number { return this.next(); }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]!; }
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![0];
  }
}

const CHILD_KEYS = ['a', 'b', 'c', 'n', 't', '1', '2', '10'];
const USER_IDS = ['alice', 'bob'];
/** `$me` is replaced with the signed-in user's uid when the step runs. */
const PATHS = [
  'items', 'items/a', 'items/b', 'items/c', 'items/1', 'items/a/n',
  'counters', 'counters/x', 'counters/y',
  'users/alice', 'users/bob', 'users/$me', 'users/alice/name',
  'rooms/r1/messages', 'rooms/r1/messages/m1', 'rooms/r1',
  'meta', 'meta/stamp',
];
const LISTEN_PATHS = ['items', 'counters', 'users', 'rooms/r1/messages', 'meta', 'items/a', 'users/alice', ''];

function primitive(draw: Draw): JsonValue {
  return draw.weighted<() => JsonValue>([
    [() => draw.int(-3, 120), 4],
    [() => draw.pick(['x', 'y', 'hello', '', 'b', '10']), 3],
    [() => draw.chance(0.5), 1],
    [() => draw.int(0, 1000) / 8, 1],
    [() => null, 1],
  ])();
}

function value(draw: Draw, depth = 0): WriteValue {
  const kind = draw.weighted<string>([
    ['primitive', 5], ['object', depth < 2 ? 3 : 0], ['timestamp', 1], ['increment', 1], ['array', depth < 1 ? 0.5 : 0],
  ]);
  if (kind === 'timestamp') return { $ts: true };
  if (kind === 'increment') return { $inc: draw.pick([1, 2, -1, 5]) };
  if (kind === 'array') return [primitive(draw), primitive(draw)];
  if (kind === 'object') {
    const out: Record<string, WriteValue> = {};
    const count = draw.int(1, 3);
    for (let i = 0; i < count; i++) out[draw.pick(CHILD_KEYS)] = value(draw, depth + 1);
    if (draw.chance(0.15)) out['.priority'] = draw.pick([1, 5, 'p', 200]);
    return out;
  }
  return primitive(draw);
}

function updateValues(draw: Draw): Record<string, WriteValue> {
  if (draw.chance(0.1)) return {};
  const out: Record<string, WriteValue> = {};
  const count = draw.int(1, 4);
  for (let i = 0; i < count; i++) {
    const segments = draw.int(1, 2);
    const keys: string[] = [];
    for (let s = 0; s < segments; s++) keys.push(draw.pick(CHILD_KEYS));
    out[keys.join('/')] = value(draw, 1);
  }
  return out;
}

function priority(draw: Draw): string | number | null {
  return draw.pick<string | number | null>([null, 1, 2, 50, 150, 'a', 'z', 0]);
}

function bound(draw: Draw, orderBy: QuerySpec['orderBy']): { value: JsonValue; key?: string } {
  let boundValue: JsonValue;
  if (orderBy === 'key') boundValue = draw.pick(['a', 'b', 'c', '1', '2']);
  else if (orderBy === 'priority') boundValue = draw.pick<JsonValue>([1, 50, 'a', null]);
  else boundValue = draw.pick<JsonValue>([0, 5, 10, 'b', 'x', true, null]);
  const withKey = orderBy !== 'key' && draw.chance(0.25);
  return withKey ? { value: boundValue, key: draw.pick(['a', 'b', '1']) } : { value: boundValue };
}

function query(draw: Draw): QuerySpec | undefined {
  if (draw.chance(0.45)) return undefined;
  const orderBy = draw.weighted<QuerySpec['orderBy']>([
    ['key', 2], ['value', 2], ['priority', 1], [{ child: 'n' }, 3],
  ]);
  const spec: QuerySpec = { orderBy };
  const filter = draw.weighted<string>([['none', 2], ['start', 2], ['end', 1], ['range', 2], ['equal', 1], ['after', 1], ['before', 1]]);
  if (filter === 'start' || filter === 'range') spec.startAt = bound(draw, orderBy);
  if (filter === 'end' || filter === 'range') spec.endAt = bound(draw, orderBy);
  if (filter === 'equal') spec.equalTo = bound(draw, orderBy);
  if (filter === 'after') spec.startAfter = bound(draw, orderBy);
  if (filter === 'before') spec.endBefore = bound(draw, orderBy);
  const limit = draw.weighted<string>([['none', 2], ['first', 1], ['last', 1]]);
  if (limit === 'first') spec.limitToFirst = draw.int(1, 3);
  if (limit === 'last') spec.limitToLast = draw.int(1, 3);
  return spec;
}

function claims(draw: Draw): Record<string, JsonValue> | undefined {
  return draw.pick<Record<string, JsonValue> | undefined>([
    undefined,
    { role: 'editor' },
    { role: 'admin', tier: 3 },
    { tier: 1 },
    { role: 'viewer', tier: 2 },
  ]);
}

const TRANSACTION_SCRIPTS: TransactionScript[] = ['increment', 'abort', 'createOnly', 'replaceObject', 'delete', 'contend'];

export interface GeneratorOptions {
  /** Steps per sequence, inclusive range. */
  minSteps?: number;
  maxSteps?: number;
}

export function generateSequence(seed: number, options: GeneratorOptions = {}): Sequence {
  const draw = new Draw(prng(seed));
  const instances = draw.chance(0.5) ? 2 : 3;
  const initialRules: number[] = [];
  for (let i = 0; i < instances; i++) {
    initialRules.push(draw.weighted<number>([[0, 3], [1, 1], [2, 2], [3, 1], [4, 1], [5, 1], [6, 0.3], [7, 1]]));
  }
  const steps: Step[] = [];
  const count = draw.int(options.minSteps ?? 6, options.maxSteps ?? 24);
  let nextListener = 0;
  const openListeners: number[] = [];
  const db = () => draw.int(0, instances - 1);
  const path = () => draw.pick(PATHS);
  if (draw.chance(0.4)) steps.push({ op: 'signIn', uid: draw.pick(USER_IDS), claims: claims(draw) });
  for (let i = 0; i < count; i++) {
    const op = draw.weighted<Step['op']>([
      ['set', 6], ['update', 4], ['push', 2], ['remove', 2], ['transaction', 3],
      ['setPriority', 1], ['setWithPriority', 1],
      ['onDisconnectSet', 1], ['onDisconnectUpdate', 1], ['onDisconnectRemove', 1], ['onDisconnectCancel', 0.5],
      ['reconnect', 1.5],
      ['listen', 4], ['unlisten', 1], ['get', 3],
      ['signIn', 1.5], ['signInAnonymously', 0.5], ['signOut', 1], ['refreshToken', 0.5],
      ['rules', 1],
    ]);
    switch (op) {
      case 'set': steps.push({ op, db: db(), path: path(), value: value(draw) }); break;
      case 'update': steps.push({ op, db: db(), path: path(), values: updateValues(draw) }); break;
      case 'push': steps.push(draw.chance(0.2)
        ? { op, db: db(), path: draw.pick(['items', 'rooms/r1/messages']) }
        : { op, db: db(), path: draw.pick(['items', 'rooms/r1/messages']), value: draw.chance(0.5) ? { t: 'hi', n: draw.int(0, 9) } : value(draw) });
        break;
      case 'remove': steps.push({ op, db: db(), path: path() }); break;
      case 'transaction':
        steps.push({ op, db: db(), path: draw.pick(['counters/x', 'counters/y', 'items/a', 'meta', 'users/$me']), script: draw.pick(TRANSACTION_SCRIPTS), ...(draw.chance(0.2) ? { applyLocally: false } : {}) });
        break;
      case 'setPriority': steps.push({ op, db: db(), path: path(), priority: priority(draw) }); break;
      case 'setWithPriority': steps.push({ op, db: db(), path: path(), value: value(draw), priority: priority(draw) }); break;
      case 'onDisconnectSet': steps.push(draw.chance(0.3)
        ? { op, db: db(), path: path(), value: value(draw), priority: priority(draw) }
        : { op, db: db(), path: path(), value: value(draw) });
        break;
      case 'onDisconnectUpdate': steps.push({ op, db: db(), path: path(), values: updateValues(draw) }); break;
      case 'onDisconnectRemove': steps.push({ op, db: db(), path: path() }); break;
      case 'onDisconnectCancel': steps.push({ op, db: db(), path: draw.chance(0.5) ? path() : '' }); break;
      case 'reconnect': steps.push({ op, db: db() }); break;
      case 'listen': {
        const id = nextListener++;
        openListeners.push(id);
        const event = draw.weighted<ListenEvent>([['value', 3], ['child_added', 2], ['child_changed', 2], ['child_removed', 1.5], ['child_moved', 1]]);
        const spec = query(draw);
        steps.push({ op, db: db(), id, path: draw.pick(LISTEN_PATHS), event, ...(spec ? { query: spec } : {}) });
        break;
      }
      case 'unlisten': {
        if (openListeners.length === 0) break;
        const index = draw.int(0, openListeners.length - 1);
        steps.push({ op, id: openListeners.splice(index, 1)[0]! });
        break;
      }
      case 'get': {
        const spec = query(draw);
        steps.push({ op, db: db(), path: draw.pick([...LISTEN_PATHS, ...PATHS]), ...(spec ? { query: spec } : {}) });
        break;
      }
      case 'signIn': steps.push({ op, uid: draw.pick(USER_IDS), claims: claims(draw) }); break;
      case 'signInAnonymously': steps.push({ op }); break;
      case 'signOut': steps.push({ op }); break;
      case 'refreshToken': steps.push({ op }); break;
      case 'rules': steps.push({ op, db: db(), rules: draw.int(0, RULES_POOL.length - 1) }); break;
    }
  }
  return { seed, instances, initialRules, steps };
}
