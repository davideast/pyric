/**
 * Tool factories for `pyric/firestore` per F1.
 *
 * `createFirestoreDataTools({ resolveDb })` wraps the modular
 * Web-SDK Firestore data plane as `ToolHandler[]`. The resolver
 * returns either an admin-mode `Firestore` (admin-bypassed) or a
 * `FirebaseServerApp`-backed Firestore (rules-enforced as a
 * specific user) depending on the host's flow.
 *
 * Per F2 + F4: `resolveDb` is a resolver called per-dispatch with
 * the optional `auth` arg from the tool's input. Hosts wire it to
 * whichever backend they have.
 */

import type { ToolHandler } from '../sandbox/internal/tool-handler.js';
import { QUERY_WHERE_OPERATORS } from './sandbox/query-operators.js';
import {
  copyUnescapedUserMapTag,
  isRegisteredFieldValueSentinel,
  isUnescapedUserMap,
  markFieldValueSentinel,
} from './sandbox/unescaped-map.js';
import type { LocalSandbox } from 'pyric/sandbox';
import { inspect } from './sandbox-controls.js';
import type { Firestore, QueryConstraint, SetOptions } from './index.js';
import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
} from './index.js';

export interface UserAuth {
  uid: string;
  claims?: Record<string, unknown>;
  /** The tenant the identity signed in under; rules read it as `request.auth.token.firebase.tenant`. */
  tenant?: string;
}

/**
 * Who a data-plane op runs as. The default (omitted, or the literal `'admin'`)
 * is an ADMIN write that BYPASSES rules - the right mode for sandbox seeding.
 * A `{ uid, claims? }` runs as that user with rules ENFORCED. The point of the
 * explicit literal: bypass is NAMED (`as:'admin'`), not the silent consequence
 * of omitting an auth field, and acting-as-a-user is named too.
 */
export type As = 'admin' | UserAuth;

/** JSONSchema for the `as` arg: the string `'admin'` OR `{ uid, claims? }`. */
const AS_SCHEMA = {
  description:
    "Identity to act as. Omit or 'admin' = admin write that BYPASSES rules (sandbox seeding). { uid, claims? } = act as that user with rules ENFORCED.",
  oneOf: [
    { type: 'string' as const, enum: ['admin'] },
    {
      type: 'object' as const,
      properties: {
        uid: { type: 'string' as const },
        tenant: { type: 'string' as const, description: 'Tenant id, visible to rules as request.auth.token.firebase.tenant.' },
        claims: { type: 'object' as const, description: 'Custom claims forwarded to the rule context (request.auth.token).' },
      },
      required: ['uid'],
    },
  ],
};

/** Constrain where-op to the WhereFilterOp union at the schema level. */
type WhereOp = typeof QUERY_WHERE_OPERATORS[number];

interface WhereClause {
  field: string;
  op: WhereOp;
  value: unknown;
}

interface OrderByClause {
  field: string;
  direction?: 'asc' | 'desc';
}

type OrderByArg = string | OrderByClause[];

interface ToolSetOptions {
  merge?: boolean;
  mergeFields?: string[];
}

const WHERE_CLAUSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    field: { type: 'string' as const },
    op: { type: 'string' as const, enum: [...QUERY_WHERE_OPERATORS] },
    value: {},
  },
  required: ['field', 'op', 'value'],
};

const ORDER_BY_SCHEMA = {
  description: 'Field name (ascending) or ordered list of `{ field, direction? }` clauses.',
  oneOf: [
    { type: 'string' as const },
    {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          field: { type: 'string' as const },
          direction: { type: 'string' as const, enum: ['asc', 'desc'] },
        },
        required: ['field'],
      },
    },
  ],
};

const SET_OPTIONS_SCHEMA = {
  type: 'object' as const,
  description: 'Set options: `{ merge: true }` or `{ mergeFields: [...] }`.',
  properties: {
    merge: { type: 'boolean' as const },
    mergeFields: { type: 'array' as const, items: { type: 'string' as const } },
  },
};

const DATABASE_SCHEMA = {
  type: 'string' as const,
  description: 'Optional Firestore database id. Omit or "(default)" targets the default database.',
};

export interface FirestoreDataToolDeps {
  /**
   * Resolver returning a `Firestore` handle. Called per-dispatch with the
   * op's `as` value: `'admin'` (or undefined) -> an admin-bypass Firestore;
   * `{ uid, claims? }` -> a rules-enforcing Firestore acting as that user.
   *
   * The host decides the posture; the tool layer does NOT enforce it. A sandbox
   * resolver may default to admin (rules bypass is the point of seeding), but a
   * resolver wired to a real backend should require an explicit identity or
   * confirm-gate admin writes (see the bridge's prod confirm-policy).
   */
  resolveDb(as?: As, database?: string): Promise<Firestore> | Firestore;
}

export interface FirestoreInspectToolDeps {
  /** Resolve the sandbox whose Firestore state should be inspected. */
  resolveSandbox(): Promise<LocalSandbox> | LocalSandbox;
}

function rehydrateToolWriteData(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(rehydrateToolWriteData);
  if (isRegisteredFieldValueSentinel(value)) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const rec = value as Record<string, unknown>;
  if (!isUnescapedUserMap(rec)) {
    const keys = Object.keys(rec);
    if (rec.__type === 'serverTimestamp' && keys.length === 1) {
      return markFieldValueSentinel({ __type: 'serverTimestamp' });
    }
    if (rec.__type === 'deleteField' && keys.length === 1) {
      return markFieldValueSentinel({ __type: 'deleteField' });
    }
    if (rec.__type === 'increment' && keys.length === 2 && typeof rec.value === 'number') {
      return markFieldValueSentinel({ __type: 'increment', value: rec.value });
    }
    if (
      (rec.__type === 'arrayUnion' || rec.__type === 'arrayRemove') &&
      keys.length === 2 &&
      Array.isArray(rec.values)
    ) {
      return markFieldValueSentinel({
        __type: rec.__type,
        values: rec.values.map(rehydrateToolWriteData),
      });
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    Object.defineProperty(out, k, {
      value: rehydrateToolWriteData(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copyUnescapedUserMapTag(rec, out);
}

function buildSetOptions(raw: ToolSetOptions | undefined): SetOptions | undefined {
  if (raw === undefined) return undefined;
  const hasMerge = typeof raw.merge === 'boolean';
  const hasMergeFields = Array.isArray(raw.mergeFields);
  if (!hasMerge && !hasMergeFields) return undefined;
  const out: SetOptions = {};
  if (hasMerge) out.merge = raw.merge;
  if (hasMergeFields) out.mergeFields = raw.mergeFields;
  return out;
}

function appendOrderAndLimitConstraints(
  constraints: QueryConstraint[],
  orderByArg: OrderByArg | undefined,
  limitArg: number | undefined,
  limitsArg: number[] | undefined,
): void {
  if (typeof orderByArg === 'string' && orderByArg.length > 0) {
    constraints.push(orderBy(orderByArg));
  } else if (Array.isArray(orderByArg)) {
    for (const clause of orderByArg) {
      constraints.push(orderBy(clause.field, clause.direction));
    }
  }
  if (Array.isArray(limitsArg) && limitsArg.length > 0) {
    for (const count of limitsArg) {
      constraints.push(limit(count));
    }
  } else if (limitArg !== undefined) {
    constraints.push(limit(limitArg));
  }
}

/**
 * Modular Web-SDK-shaped Firestore data tools - get, list, create,
 * update, delete, batch, and query. Each tool's `as` arg is forwarded to the
 * resolver; omitted = admin mode, supplied = user mode.
 */
export function createFirestoreDataTools(deps: FirestoreDataToolDeps): ToolHandler[] {
  const { resolveDb } = deps;
  return [
    {
      name: 'firestore_get_document',
      description: 'Get a Firestore document by path. Admin by default; pass `as:{uid}` to read with rules enforced as that user.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "users/alice"' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; database?: string; as?: As };
        const db = await resolveDb(a.as, a.database);
        const ref = doc(db, a.path);
        const snap = await getDoc(ref);
        const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
        return {
          ok: true,
          summary: exists ? `Got ${a.path}` : `No document at ${a.path}`,
          data: { exists, data: exists ? snap.data() : null },
        };
      },
    },
    {
      name: 'firestore_list_documents',
      description: 'List documents in a collection. Supports orderBy + limit. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          orderBy: ORDER_BY_SCHEMA,
          limit: { type: 'number' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['collection'],
      },
      async execute(args) {
        const a = args as {
          collection: string;
          orderBy?: OrderByArg;
          limit?: number;
          limits?: number[];
          database?: string;
          as?: As;
        };
        const db = await resolveDb(a.as, a.database);
        const baseColl = collection(db, a.collection);
        const constraints: QueryConstraint[] = [];
        appendOrderAndLimitConstraints(constraints, a.orderBy, a.limit, a.limits);
        const snap = await getDocs(query(baseColl, ...constraints));
        return {
          ok: true,
          summary: `${snap.size} docs in ${a.collection}`,
          data: { docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })) },
        };
      },
    },
    {
      name: 'firestore_create_document',
      description: 'Create or replace a Firestore document at an explicit path (or merge when `options.merge` / `options.mergeFields` is set). Admin by default (bypasses rules - for seeding); pass `as:{uid}` to write as that user with rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          data: { type: 'object' },
          options: SET_OPTIONS_SCHEMA,
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const a = args as {
          path: string;
          data: Record<string, unknown>;
          options?: ToolSetOptions;
          database?: string;
          as?: As;
        };
        const db = await resolveDb(a.as, a.database);
        const payload = rehydrateToolWriteData(a.data) as Record<string, unknown>;
        const sdkOptions = buildSetOptions(a.options);
        const merges = a.options?.merge === true || Array.isArray(a.options?.mergeFields);
        if (sdkOptions !== undefined) {
          await setDoc(doc(db, a.path), payload, sdkOptions);
        } else {
          await setDoc(doc(db, a.path), payload);
        }
        const verb = merges ? 'Updated' : 'Created';
        return { ok: true, summary: `${verb} ${a.path}` };
      },
    },
    {
      name: 'firestore_add_document',
      description: 'Add a document with an auto-generated id under a collection (mirrors the Web SDK addDoc). Admin by default - the right tool for seeding; pass `as:{uid}` to write as a user with rules enforced. Returns the minted path.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection to add the doc under, e.g. "users" or "users/u1/posts".' },
          data: { type: 'object' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['collection', 'data'],
      },
      async execute(args) {
        const a = args as { collection: string; data: Record<string, unknown>; database?: string; as?: As };
        const db = await resolveDb(a.as, a.database);
        const ref = await addDoc(
          collection(db, a.collection),
          rehydrateToolWriteData(a.data) as Record<string, unknown>,
        );
        return { ok: true, summary: `Created ${ref.path}`, data: { path: ref.path, id: ref.id } };
      },
    },
    {
      name: 'firestore_update_document',
      description: 'Merge fields into an existing Firestore document. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          data: { type: 'object' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const a = args as { path: string; data: Record<string, unknown>; database?: string; as?: As };
        const db = await resolveDb(a.as, a.database);
        await updateDoc(doc(db, a.path), rehydrateToolWriteData(a.data) as Record<string, unknown>);
        return { ok: true, summary: `Updated ${a.path}` };
      },
    },
    {
      name: 'firestore_delete_document',
      description: 'Delete a Firestore document. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; database?: string; as?: As };
        const db = await resolveDb(a.as, a.database);
        await deleteDoc(doc(db, a.path));
        return { ok: true, summary: `Deleted ${a.path}` };
      },
    },
    {
      name: 'firestore_batch_write',
      description: 'Commit many writes (set / update / delete) atomically in ONE call - the efficient way to seed or bulk-edit (one call, not N). All writes succeed or none are applied. Admin by default; pass `as:{uid}` to apply them as a user with rules enforced. Up to 500 ops.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: 'Writes committed atomically as a batch; if any write fails, none are applied.',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['set', 'update', 'delete'] },
                path: { type: 'string' },
                data: { type: 'object', description: 'Required for set/update; ignored for delete.' },
                options: SET_OPTIONS_SCHEMA,
              },
              required: ['op', 'path'],
            },
          },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['operations'],
      },
      async execute(args) {
        const a = args as {
          operations: Array<{
            op: 'set' | 'update' | 'delete';
            path: string;
            data?: Record<string, unknown>;
            options?: ToolSetOptions;
          }>;
          database?: string;
          as?: As;
        };
        if (a.operations.length === 0 || a.operations.length > 500) {
          return { ok: false, summary: `firestore_batch_write: operations must be 1..500 (got ${a.operations.length}).` };
        }
        const db = await resolveDb(a.as, a.database);
        const batch = writeBatch(db);
        for (const o of a.operations) {
          const ref = doc(db, o.path);
          if (o.op === 'set') {
            const payload = rehydrateToolWriteData(o.data ?? {}) as Record<string, unknown>;
            const sdkOptions = buildSetOptions(o.options);
            if (sdkOptions !== undefined) {
              batch.set(ref, payload, sdkOptions);
            } else {
              batch.set(ref, payload);
            }
          } else if (o.op === 'update') {
            batch.update(ref, rehydrateToolWriteData(o.data ?? {}) as Record<string, unknown>);
          } else {
            batch.delete(ref);
          }
        }
        await batch.commit();
        return { ok: true, summary: `Applied ${a.operations.length} write(s)`, data: { count: a.operations.length } };
      },
    },
    {
      name: 'firestore_query_where',
      description: 'Query a collection with one or more where clauses (AND-semantics) + optional orderBy + limit. For OR semantics use a single where clause with the `in` / `array-contains-any` op. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          where: {
            type: 'array',
            description: 'One or more where clauses. AND across clauses.',
            items: WHERE_CLAUSE_SCHEMA,
            minItems: 1,
          },
          orderBy: ORDER_BY_SCHEMA,
          limit: { type: 'number' },
          database: DATABASE_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['collection', 'where'],
      },
      async execute(args) {
        const a = args as {
          collection: string;
          where: WhereClause[];
          orderBy?: OrderByArg;
          limit?: number;
          limits?: number[];
          database?: string;
          as?: As;
        };
        const db = await resolveDb(a.as, a.database);
        const baseColl = collection(db, a.collection);
        const constraints: QueryConstraint[] = a.where.map((w) => where(w.field, w.op, w.value));
        appendOrderAndLimitConstraints(constraints, a.orderBy, a.limit, a.limits);
        const snap = await getDocs(query(baseColl, ...constraints));
        return {
          ok: true,
          summary: `${snap.size} matches in ${a.collection}`,
          data: { docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })) },
        };
      },
    },
  ];
}

/**
 * `sandbox_inspect` - single-call sandbox diagnostic returning current rules
 * source, lint summary, doc count by collection, and recent denials + requests
 * from `sandbox.history()`.
 */
export function createFirestoreInspectTools(deps: FirestoreInspectToolDeps): ToolHandler[] {
  const { resolveSandbox } = deps;
  return [
    {
      name: 'sandbox_inspect',
      description:
        'Single-call sandbox diagnostic. Returns current rules source, lint summary, doc count by collection, and recent denials + requests. Use this FIRST when debugging unexpected sandbox behavior - it surfaces the rules / state / event log without forcing per-tool grep.',
      parameters: {
        type: 'object',
        properties: {
          recentEventLimit: {
            type: 'number',
            description: 'Cap on recent denials/requests returned. Default 10.',
            default: 10,
          },
          database: DATABASE_SCHEMA,
        },
      },
      async execute(args) {
        const a = args as { recentEventLimit?: number; database?: string };
        const sandbox = await resolveSandbox();
        const report = inspect(sandbox, {
          recentEventLimit: a.recentEventLimit,
          databaseId: a.database,
        });
        let rulesPart = `${report.rules.sizeBytes}B, ${report.rules.lint.errors} errors / ${report.rules.lint.warnings} warnings`;
        if (report.rules.isEmpty) {
          rulesPart = 'EMPTY (setRules has not been called)';
        }
        const dot = '\u00b7';
        const summary =
          `rules: ${rulesPart}`
          + ` ${dot} docs: ${report.documents.totalCount} across ${Object.keys(report.documents.byCollection).length} collections`
          + ` ${dot} events: ${report.events.totalCount} total, ${report.events.recentDenials.length} recent denials`;
        return {
          ok: true,
          summary,
          data: report,
        };
      },
    },
  ];
}
