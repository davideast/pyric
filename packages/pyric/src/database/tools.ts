/**
 * Tool factory for the `pyric/database` data plane.
 *
 * `createDatabaseDataTools({ resolveDatabase })` wraps the modular
 * Realtime Database API as `ToolHandler[]`. The resolver is called per
 * dispatch with the op's `as` value and returns either an admin handle
 * (rules bypassed) or a rules-enforcing handle acting as one user. The
 * host decides the posture; the tool layer does not enforce it.
 *
 * Write values pass through unchanged, so the `{ ".sv": "timestamp" }` and
 * `{ ".sv": { "increment": n } }` sentinels reach the sandbox backend, which
 * resolves them at the write boundary exactly as it does for values built
 * with `serverTimestamp()` and `increment()`.
 */

import type { ToolHandler } from '@inbrowser/agent';
import type { JsonValue } from './sandbox/data-tree.js';
import { setData } from './sandbox-controls.js';
import type { DataSnapshot, Database, QueryConstraint } from './types.js';
import { ref } from './references.js';
import { get, push, remove, set, update } from './operations.js';
import { runTransaction } from './transactions.js';
import {
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  startAfter,
  startAt,
} from './queries.js';

export interface DatabaseUserAuth {
  uid: string;
  claims?: Record<string, unknown>;
}

/**
 * Who a data-plane op runs as. Omitted, or the literal `'admin'`, is an
 * admin operation that bypasses rules. `{ uid, claims? }` runs as that user
 * with rules enforced.
 */
export type DatabaseAs = 'admin' | DatabaseUserAuth;

export interface DatabaseDataToolDeps {
  /**
   * Resolver returning a `Database` handle for the op's `as` value:
   * `'admin'` (or undefined) yields an admin handle that bypasses rules;
   * `{ uid, claims? }` yields a rules-enforcing handle acting as that user.
   */
  resolveDatabase(as?: DatabaseAs): Promise<Database> | Database;
}

const AS_SCHEMA = {
  description:
    "Identity to act as. Omit or 'admin' = admin operation that bypasses rules. { uid, claims? } = act as that user with rules enforced; claims populate auth.token.",
  oneOf: [
    { type: 'string' as const, enum: ['admin'] },
    {
      type: 'object' as const,
      properties: {
        uid: { type: 'string' as const },
        claims: { type: 'object' as const, description: 'Custom claims visible to rules as auth.token.' },
      },
      required: ['uid'],
    },
  ],
};

const PATH_SCHEMA = { type: 'string' as const, description: 'Absolute path in the tree, for example "/users/alice".' };

const SENTINEL_NOTE =
  'Values may contain the sentinels { ".sv": "timestamp" } (resolves to the write time in epoch milliseconds) and { ".sv": { "increment": n } } (adds n to the stored number, from 0 when absent); the sandbox resolves them at write time.';

/** Any JSON value. A typed union rather than an untyped field so a required value is enforced. */
const JSON_VALUE_VARIANTS = [
  { type: 'object' as const },
  { type: 'array' as const },
  { type: 'string' as const },
  { type: 'number' as const },
  { type: 'boolean' as const },
  { type: 'null' as const },
];

const jsonValue = (description: string) => ({ description, anyOf: JSON_VALUE_VARIANTS });

const VALUE_SCHEMA = jsonValue(`JSON value to write; null deletes. ${SENTINEL_NOTE}`);

const BOUND_VARIANTS = [
  { type: 'string' as const },
  { type: 'number' as const },
  { type: 'boolean' as const },
  { type: 'null' as const },
];

const bound = (name: string, edge: string) => ({
  description: `${edge} bound on the ordered value; ${name} of the query window.`,
  anyOf: BOUND_VARIANTS,
});

const ORDER_BY = ['child', 'key', 'value', 'priority'] as const;
type OrderBy = (typeof ORDER_BY)[number];

interface QueryArgs {
  path: string;
  orderBy: OrderBy;
  childKey?: string;
  limitToFirst?: number;
  limitToLast?: number;
  startAt?: JsonValue;
  startAfter?: JsonValue;
  endAt?: JsonValue;
  endBefore?: JsonValue;
  equalTo?: JsonValue;
  as?: DatabaseAs;
}

function orderingConstraint(args: QueryArgs): QueryConstraint {
  switch (args.orderBy) {
    case 'child':
      if (!args.childKey) throw new Error("query: orderBy 'child' requires childKey");
      return orderByChild(args.childKey);
    case 'key':
      return orderByKey();
    case 'value':
      return orderByValue();
    case 'priority':
      return orderByPriority();
  }
}

function queryConstraints(args: QueryArgs): QueryConstraint[] {
  const constraints = [orderingConstraint(args)];
  if (args.startAt !== undefined) constraints.push(startAt(args.startAt));
  if (args.startAfter !== undefined) constraints.push(startAfter(args.startAfter));
  if (args.endAt !== undefined) constraints.push(endAt(args.endAt));
  if (args.endBefore !== undefined) constraints.push(endBefore(args.endBefore));
  if (args.equalTo !== undefined) constraints.push(equalTo(args.equalTo));
  if (args.limitToFirst !== undefined) constraints.push(limitToFirst(args.limitToFirst));
  if (args.limitToLast !== undefined) constraints.push(limitToLast(args.limitToLast));
  return constraints;
}

function orderedRows(snap: DataSnapshot): Array<{ key: string; value: JsonValue }> {
  const rows: Array<{ key: string; value: JsonValue }> = [];
  snap.forEach((child) => {
    rows.push({ key: child.key as string, value: child.val() });
  });
  return rows;
}

function sameValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Realtime Database data tools: get, set, update, remove, push,
 * transaction, query, and seed. Each op's `as` argument is forwarded to
 * the resolver; omitted means admin, supplied means that user.
 */
export function createDatabaseDataTools(deps: DatabaseDataToolDeps): ToolHandler[] {
  const { resolveDatabase } = deps;
  return [
    {
      name: 'database_get',
      description:
        'Read the value at a path. Admin by default; pass `as:{uid}` to read with rules enforced as that user.',
      parameters: {
        type: 'object',
        properties: { path: PATH_SCHEMA, as: AS_SCHEMA },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; as?: DatabaseAs };
        const db = await resolveDatabase(a.as);
        const snap = await get(ref(db, a.path));
        const exists = snap.exists();
        return {
          ok: true,
          summary: exists ? `Got ${a.path}` : `No value at ${a.path}`,
          data: { exists, value: snap.val() },
        };
      },
    },
    {
      name: 'database_set',
      description: `Replace the value at a path; null deletes. Admin by default (bypasses rules); pass \`as:{uid}\` to write as that user with rules enforced. ${SENTINEL_NOTE}`,
      parameters: {
        type: 'object',
        properties: { path: PATH_SCHEMA, value: VALUE_SCHEMA, as: AS_SCHEMA },
        required: ['path', 'value'],
      },
      async execute(args) {
        const a = args as { path: string; value: JsonValue; as?: DatabaseAs };
        const db = await resolveDatabase(a.as);
        await set(ref(db, a.path), a.value);
        return { ok: true, summary: `Set ${a.path}` };
      },
    },
    {
      name: 'database_update',
      description: `Write several children or paths under one path atomically. Keys without "/" replace that child; keys containing "/" are relative paths written together as one multi-path update, so a denial on any path fails the whole write. Admin by default; pass \`as:{uid}\` to enforce rules. ${SENTINEL_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          path: PATH_SCHEMA,
          values: {
            type: 'object',
            description: `Map of child key or relative path to value; null deletes. ${SENTINEL_NOTE}`,
          },
          as: AS_SCHEMA,
        },
        required: ['path', 'values'],
      },
      async execute(args) {
        const a = args as { path: string; values: Record<string, JsonValue>; as?: DatabaseAs };
        const db = await resolveDatabase(a.as);
        await update(ref(db, a.path), a.values);
        const count = Object.keys(a.values).length;
        return { ok: true, summary: `Updated ${count} path${count === 1 ? '' : 's'} under ${a.path}` };
      },
    },
    {
      name: 'database_remove',
      description:
        'Delete the subtree at a path. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: { path: PATH_SCHEMA, as: AS_SCHEMA },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; as?: DatabaseAs };
        const db = await resolveDatabase(a.as);
        await remove(ref(db, a.path));
        return { ok: true, summary: `Removed ${a.path}` };
      },
    },
    {
      name: 'database_push',
      description: `Mint a push key under a path and, when value is supplied, write value at the new child. Returns the key and the child path. Admin by default; pass \`as:{uid}\` to enforce rules. ${SENTINEL_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          path: PATH_SCHEMA,
          value: jsonValue(`Optional JSON value to write at the new child. ${SENTINEL_NOTE}`),
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; value?: JsonValue; as?: DatabaseAs };
        const db = await resolveDatabase(a.as);
        const child = await push(ref(db, a.path), a.value);
        const key = child.key as string;
        return {
          ok: true,
          summary: a.value === undefined ? `Minted ${key} under ${a.path}` : `Pushed ${key} under ${a.path}`,
          data: { key, path: child._path },
        };
      },
    },
    {
      name: 'database_transaction',
      description:
        'Compare-and-set at a path over runTransaction. Without expect, writes value unconditionally inside the transaction. With expect, writes value only when the current value equals expect; otherwise the transaction aborts and the current value is returned with committed false. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          path: PATH_SCHEMA,
          value: jsonValue('JSON value to write when the transaction commits; null deletes.'),
          expect: jsonValue(
            'Value the path must currently hold for the write to apply; use null to require the path to be absent. Omit to write unconditionally.',
          ),
          as: AS_SCHEMA,
        },
        required: ['path', 'value'],
      },
      async execute(args) {
        const a = args as { path: string; value: JsonValue; expect?: JsonValue; as?: DatabaseAs };
        const guarded = Object.prototype.hasOwnProperty.call(args, 'expect');
        const db = await resolveDatabase(a.as);
        const result = await runTransaction<JsonValue>(ref(db, a.path), (current) => {
          if (guarded && !sameValue(current, a.expect ?? null)) return undefined;
          return a.value;
        });
        const value = result.snapshot.val();
        return {
          ok: true,
          summary: result.committed
            ? `Committed ${a.path}`
            : `Aborted ${a.path}: current value differs from expect`,
          data: { committed: result.committed, value },
        };
      },
    },
    {
      name: 'database_query',
      description:
        "Read the ordered children of a path through a query window. orderBy selects the ordering ('child' needs childKey); startAt, startAfter, endAt, endBefore, and equalTo bound the ordered value; limitToFirst or limitToLast trims the window. Rows come back in query order. Admin by default; pass `as:{uid}` to enforce rules.",
      parameters: {
        type: 'object',
        properties: {
          path: PATH_SCHEMA,
          orderBy: {
            type: 'string',
            enum: [...ORDER_BY],
            description: "Ordering: 'child' (by the child at childKey), 'key', 'value', or 'priority'.",
          },
          childKey: { type: 'string', description: "Child path to order by when orderBy is 'child'." },
          limitToFirst: { type: 'number', description: 'Keep the first n children of the ordered window.' },
          limitToLast: { type: 'number', description: 'Keep the last n children of the ordered window.' },
          startAt: bound('inclusive start', 'Inclusive lower'),
          startAfter: bound('exclusive start', 'Exclusive lower'),
          endAt: bound('inclusive end', 'Inclusive upper'),
          endBefore: bound('exclusive end', 'Exclusive upper'),
          equalTo: {
            description: 'Keep only children whose ordered value equals this value.',
            anyOf: BOUND_VARIANTS,
          },
          as: AS_SCHEMA,
        },
        required: ['path', 'orderBy'],
      },
      async execute(args) {
        const a = args as QueryArgs;
        const db = await resolveDatabase(a.as);
        const snap = await get(query(ref(db, a.path), ...queryConstraints(a)));
        const rows = orderedRows(snap);
        return {
          ok: true,
          summary: `${rows.length} child${rows.length === 1 ? '' : 'ren'} at ${a.path}`,
          data: { count: rows.length, rows },
        };
      },
    },
    {
      name: 'database_seed',
      description:
        "Bulk-load the tree as admin, bypassing rules: clears the whole tree, then places value at path (default '/'). Use set with as:'admin' to write one path without clearing the rest.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Absolute path the value lands at. Default '/'." },
          value: jsonValue(`JSON value for the tree at path. ${SENTINEL_NOTE}`),
        },
        required: ['value'],
      },
      async execute(args) {
        const a = args as { path?: string; value: JsonValue };
        const path = a.path ?? '/';
        const db = await resolveDatabase('admin');
        setData(db, { [path]: a.value });
        return { ok: true, summary: `Seeded ${path}` };
      },
    },
  ];
}
