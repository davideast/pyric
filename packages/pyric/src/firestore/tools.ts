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

import type { ToolHandler } from '@inbrowser/agent';
import type { Sandbox } from 'pyric/sandbox';
import { inspect } from './sandbox-controls.js';
import type { Firestore } from './index.js';
import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
} from './index.js';

export interface UserAuth {
  uid: string;
  claims?: Record<string, unknown>;
}

/**
 * Who a data-plane op runs as. The default (omitted, or the literal `'admin'`)
 * is an ADMIN write that BYPASSES rules — the right mode for sandbox seeding.
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
        claims: { type: 'object' as const, description: 'Custom claims forwarded to the rule context (request.auth.token).' },
      },
      required: ['uid'],
    },
  ],
};

/** Pre-mortem M9 — constrain where-op to the WhereFilterOp union
 *  at the schema level so agents can't pass `==` typos. */
const WHERE_OPS = ['<', '<=', '==', '!=', '>=', '>', 'in', 'not-in', 'array-contains', 'array-contains-any'] as const;
type WhereOp = typeof WHERE_OPS[number];

interface WhereClause {
  field: string;
  op: WhereOp;
  value: unknown;
}

const WHERE_CLAUSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    field: { type: 'string' as const },
    op: { type: 'string' as const, enum: [...WHERE_OPS] },
    value: {},
  },
  required: ['field', 'op', 'value'],
};

export interface FirestoreDataToolDeps {
  /**
   * Resolver returning a `Firestore` handle. Called per-dispatch with the
   * op's `as` value: `'admin'` (or undefined) → an admin-bypass Firestore;
   * `{ uid, claims? }` → a rules-enforcing Firestore acting as that user.
   *
   * The host decides the posture; the tool layer does NOT enforce it. A sandbox
   * resolver may default to admin (rules bypass is the point of seeding), but a
   * resolver wired to a real backend should require an explicit identity or
   * confirm-gate admin writes (see the bridge's prod confirm-policy).
   */
  resolveDb(as?: As): Promise<Firestore> | Firestore;
}

export interface FirestoreInspectToolDeps {
  /** Resolve the sandbox whose cross-service state should be inspected. */
  resolveSandbox(): Promise<Sandbox> | Sandbox;
}

/**
 * Modular Web-SDK-shaped Firestore data tools — get, list, create,
 * update, delete. Each tool's `auth` arg is forwarded to the
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
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; as?: As };
        const db = await resolveDb(a.as);
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
          orderBy: { type: 'string' },
          limit: { type: 'number' },
          as: AS_SCHEMA,
        },
        required: ['collection'],
      },
      async execute(args) {
        const a = args as { collection: string; orderBy?: string; limit?: number; as?: As };
        const db = await resolveDb(a.as);
        const baseColl = collection(db, a.collection);
        const constraints = [];
        if (a.orderBy) constraints.push(orderBy(a.orderBy));
        if (a.limit) constraints.push(limit(a.limit));
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
      description: 'Create or replace a Firestore document at an explicit path. Admin by default (bypasses rules — for seeding); pass `as:{uid}` to write as that user with rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          data: { type: 'object' },
          as: AS_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const a = args as { path: string; data: Record<string, unknown>; as?: As };
        const db = await resolveDb(a.as);
        await setDoc(doc(db, a.path), a.data);
        return { ok: true, summary: `Created ${a.path}` };
      },
    },
    {
      name: 'firestore_add_document',
      description: 'Add a document with an auto-generated id under a collection (mirrors the Web SDK addDoc). Admin by default — the right tool for seeding; pass `as:{uid}` to write as a user with rules enforced. Returns the minted path.',
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection to add the doc under, e.g. "users" or "users/u1/posts".' },
          data: { type: 'object' },
          as: AS_SCHEMA,
        },
        required: ['collection', 'data'],
      },
      async execute(args) {
        const a = args as { collection: string; data: Record<string, unknown>; as?: As };
        const db = await resolveDb(a.as);
        const ref = await addDoc(collection(db, a.collection), a.data);
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
          as: AS_SCHEMA,
        },
        required: ['path', 'data'],
      },
      async execute(args) {
        const a = args as { path: string; data: Record<string, unknown>; as?: As };
        const db = await resolveDb(a.as);
        await updateDoc(doc(db, a.path), a.data);
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
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; as?: As };
        const db = await resolveDb(a.as);
        await deleteDoc(doc(db, a.path));
        return { ok: true, summary: `Deleted ${a.path}` };
      },
    },
    {
      name: 'firestore_batch_write',
      description: 'Apply many writes (set / update / delete) in ONE call — the efficient way to seed or bulk-edit (one call, not N). Applied in order; stops on the first failure. Admin by default; pass `as:{uid}` to apply them as a user with rules enforced. Up to 500 ops.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: 'Writes applied in order; stops on the first failure (NOT atomic — earlier writes are not rolled back).',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['set', 'update', 'delete'] },
                path: { type: 'string' },
                data: { type: 'object', description: 'Required for set/update; ignored for delete.' },
              },
              required: ['op', 'path'],
            },
          },
          as: AS_SCHEMA,
        },
        required: ['operations'],
      },
      async execute(args) {
        const a = args as {
          operations: Array<{ op: 'set' | 'update' | 'delete'; path: string; data?: Record<string, unknown> }>;
          as?: As;
        };
        // The schema's minItems/maxItems aren't enforced by the MCP validation
        // boundary, so guard the documented 1..500 bound here.
        if (a.operations.length === 0 || a.operations.length > 500) {
          return { ok: false, summary: `firestore_batch_write: operations must be 1..500 (got ${a.operations.length}).` };
        }
        const db = await resolveDb(a.as);
        // Applied in order via the modular API. (The shim's WriteBatch ref type
        // has drifted from doc()'s return in the .d.ts; sequential keeps this
        // typesafe and is fine for the seed / bulk-edit use case.)
        for (const o of a.operations) {
          const ref = doc(db, o.path);
          if (o.op === 'set') await setDoc(ref, o.data ?? {});
          else if (o.op === 'update') await updateDoc(ref, o.data ?? {});
          else await deleteDoc(ref);
        }
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
          orderBy: { type: 'string' },
          limit: { type: 'number' },
          as: AS_SCHEMA,
        },
        required: ['collection', 'where'],
      },
      async execute(args) {
        const a = args as {
          collection: string;
          where: WhereClause[];
          orderBy?: string;
          limit?: number;
          as?: As;
        };
        const db = await resolveDb(a.as);
        const baseColl = collection(db, a.collection);
        const constraints = a.where.map((w) => where(w.field, w.op, w.value));
        if (a.orderBy) constraints.push(orderBy(a.orderBy));
        if (a.limit) constraints.push(limit(a.limit));
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
 * `sandbox_inspect` — the missing-tool tax this entire library
 * used to charge agents. Without it, debugging "why aren't my rules
 * working?" took 51 tool calls + 72k tokens of grepping node_modules
 * (recorded in CLAUDE_DEBUG_SESSION.md). With it, the same diagnosis
 * is one tool call:
 *
 *   { rules: { source, sizeBytes, isEmpty, lint: { errors, warnings, findings } },
 *     documents: { totalCount, byCollection },
 *     events: { totalCount, recentDenials, recentRequests } }
 *
 * Returns a snapshot of sandbox state — current rules, lint summary,
 * document census by collection, and the most-recent denials + requests
 * from sandbox.history(). Everything an agent needs to localize a
 * sandbox bug in one round-trip.
 *
 * Sandbox-only. `resolveSandbox` must return the owning Sandbox.
 */
export function createFirestoreInspectTools(deps: FirestoreInspectToolDeps): ToolHandler[] {
  const { resolveSandbox } = deps;
  return [
    {
      name: 'sandbox_inspect',
      description:
        'Single-call sandbox diagnostic. Returns current rules source, lint summary, doc count by collection, and recent denials + requests. Use this FIRST when debugging unexpected sandbox behavior — it surfaces the rules / state / event log without forcing per-tool grep.',
      parameters: {
        type: 'object',
        properties: {
          recentEventLimit: {
            type: 'number',
            description: 'Cap on recent denials/requests returned. Default 10.',
            default: 10,
          },
        },
      },
      async execute(args) {
        const a = args as { recentEventLimit?: number };
        const sandbox = await resolveSandbox();
        const report = inspect(sandbox, {
          recentEventLimit: a.recentEventLimit,
        });
        // Punch up the summary so it's useful in tool-result previews
        // without forcing the agent to drill into `data`.
        const summary =
          `rules: ${report.rules.isEmpty ? 'EMPTY (setRules has not been called)' : `${report.rules.sizeBytes}B, ${report.rules.lint.errors} errors / ${report.rules.lint.warnings} warnings`}`
          + ` · docs: ${report.documents.totalCount} across ${Object.keys(report.documents.byCollection).length} collections`
          + ` · events: ${report.events.totalCount} total, ${report.events.recentDenials.length} recent denials`;
        return {
          ok: true,
          summary,
          data: report,
        };
      },
    },
  ];
}
