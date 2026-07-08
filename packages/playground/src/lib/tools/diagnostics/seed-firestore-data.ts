/**
 * `seed_firestore_data_as_admin` — bulk admin-bypass write/delete for
 * the in-browser sandbox. The agent supplies a list of `{path, data?,
 * method?}` operations; each is applied via the runner's `admin`
 * wrapper (`setDocument` / `deleteDocument`), bypassing the active
 * ruleset. The wrapper also schedules a persistence flush — admin
 * writes don't emit sandbox events, so seeded data would otherwise
 * never reach the per-session persisted blob.
 *
 * Why this exists: when the agent is testing rule enforcement, it
 * needs to set up fixture state that the rules under test would
 * themselves reject (e.g. seeding a document as user A so a rule
 * that restricts writes to admins can be probed). Going through the
 * normal `runOnce` write path forces the agent to author rule-passing
 * code first, which defeats the purpose. Admin-bypass cleanly
 * separates fixture setup from rule-constrained writes.
 *
 * Pinned design (NOT re-litigated this PR):
 *   - **Local-only.** The live-mode admin proxy doesn't exist; that
 *     ships separately. This tool is registered unconditionally
 *     against the local sandbox — no auth, no project required.
 *   - **`set` and `delete` only.** `create` and `update` have rule-
 *     evaluated semantics (exists-checks, field-level diffs) that
 *     defeat the point of admin-bypass; if you want those, write
 *     code that runs through the rule simulator. Default = `set`.
 *   - **100-entry cap per call.** Anything larger gets the whole
 *     call rejected with `TOO_MANY_OPERATIONS`. The agent should
 *     split into multiple calls — silent truncation hides bugs.
 *   - **No atomicity guarantee.** The sandbox has no batch-admin
 *     API. Entries are applied in order; per-entry errors are
 *     collected into `failed` / `errors[]` and the call returns
 *     `ok: true` (the BATCH ran) with a partial-success summary.
 *     The agent decides whether partial success means retry.
 *
 * Side effect: `adminSetDocument` / `adminDeleteDocument` both call
 * `notifyListenersForPaths()` so any `onSnapshot` listener attached
 * to a seeded path wakes up. This is intentional — App preview
 * subscriptions reflect seeded data without a manual refresh — but
 * note it: a noisy seed against a hot path will fire listener
 * callbacks N times.
 */
import type { ToolHandler, ToolResult } from '@inbrowser/agent';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import { generateDocId } from '~/lib/sandbox/seed-apply';

/** Hard cap. Above this, reject the whole call — never silently
 *  truncate. Why this number: 100 fits comfortably in a single
 *  tool-call context window even with large data payloads, and is
 *  generous enough that almost every fixture setup is one call. */
const MAX_OPERATIONS = 100;

type Method = 'set' | 'delete';

interface SeedOperation {
  path: string;
  data?: Record<string, unknown>;
  method?: Method;
  /** When true, treat `path` as a COLLECTION and auto-generate the doc
   *  id (like Firestore `addDoc`). Only meaningful for `set`. */
  autoId?: boolean;
}

interface SeedArgs {
  operations: SeedOperation[];
}

interface SeedError {
  path: string;
  error: string;
}

interface SeedResultData {
  applied: number;
  failed: number;
  errors?: SeedError[];
  /** Full document paths written under an `autoId` collection, so the
   *  agent can reference the generated ids in follow-up calls. Omitted
   *  when no `autoId` op ran. */
  generated?: string[];
  /** Surfaced on the rejection path so the agent can branch on it. */
  code?: 'TOO_MANY_OPERATIONS' | 'INVALID_ARGS';
}

export function buildSeedFirestoreDataHandler(): ToolHandler {
  return {
    name: 'seed_firestore_data_as_admin',
    description:
      'Bulk-apply admin-bypass writes/deletes to the in-browser sandbox. Use this to set up LIVE sandbox fixture/demo state BEFORE testing rule enforcement — e.g. seed a doc as if it were already written so a `read` rule can be probed against existing data. NOT for testing whether your rules ALLOW a write; for that, call `simulate_firestore_write` so the write evaluates against the ruleset. Method limited to `set` (default) and `delete`. For addDoc-style user-created docs, set `autoId: true` and pass a COLLECTION path; use explicit document IDs for semantic/stable docs such as `users/{uid}`, membership docs keyed by UID, config/singleton docs, lookup docs, and rule-test paths that must be referenced directly. Mixed batches are expected. Generated full paths are returned in `data.generated`; use them for follow-up references. Max 100 operations per call — anything larger gets the whole call rejected. Per-entry failures are collected into `errors[]` and do NOT abort the batch (no atomicity guarantee). Seeded paths wake any active `onSnapshot` listener so the App preview reflects the change live.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Up to 100 operations to apply, in order. Each entry is `{ path, data?, method? }`. `method` defaults to `"set"`; `data` is REQUIRED for `set` and IGNORED for `delete`. `set` semantics: replace the doc at `path` (creates if absent, overwrites if present, no merge). `delete` semantics: remove the doc at `path` (idempotent — no-op on missing path).',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                  'Slash-separated Firestore path. By default a DOCUMENT path (e.g. `users/abc`, `chats/room1/messages/m1`). When `autoId: true`, pass a COLLECTION path instead (odd number of segments, e.g. `users` or `chats/room1/messages`) and a doc id is generated.',
              },
              autoId: {
                type: 'boolean',
                description:
                  'When true, `path` is a COLLECTION path and a document id is auto-generated (like `addDoc`). Use for user-created docs such as posts, comments, tasks, messages, orders, invites, game sessions, notifications, and nested child docs created by user action. Do NOT use for semantic/stable IDs such as `users/{uid}`, membership docs keyed by UID, config/singleton docs, lookup docs, or paths that tests/rules must reference directly. Only valid for `set`; ignored for `delete`. The written full path is returned in `data.generated`.',
              },
              data: {
                type: 'object',
                description:
                  'Document body for `set`. Sentinel values (`serverTimestamp()`, `increment()`, etc.) are NOT resolved here — pass concrete values. Required when `method === "set"`; ignored for `delete`.',
              },
              method: {
                type: 'string',
                enum: ['set', 'delete'],
                description:
                  'Operation kind. Defaults to `"set"`. `create` and `update` are NOT supported here — they have rule-evaluated semantics that admin-bypass would silently break; use `simulate_firestore_write` to evaluate those against the ruleset.',
              },
            },
            required: ['path'],
          },
        },
      },
      required: ['operations'],
    },
    async execute(args: unknown): Promise<ToolResult<SeedResultData>> {
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        return {
          ok: false,
          summary: `seed_firestore_data_as_admin · ${parsed.summary}`,
          data: {
            applied: 0,
            failed: 0,
            code: parsed.code,
          },
        };
      }
      const operations = parsed.operations;

      const runtime = getPlaygroundRuntime();

      let applied = 0;
      const errors: SeedError[] = [];
      const generated: string[] = [];
      for (const op of operations) {
        try {
          const method: Method = op.method ?? 'set';
          if (method === 'set') {
            if (!op.data || typeof op.data !== 'object') {
              errors.push({
                path: op.path,
                error: '`data` is required for `set` (got missing/non-object)',
              });
              continue;
            }
            let target = op.path;
            if (op.autoId) {
              // `path` is a collection path — a collection has an ODD
              // number of segments. Reject a document path here so we
              // never write to `col/doc/genId` by mistake.
              const segments = op.path.split('/').filter(Boolean);
              if (segments.length % 2 !== 1) {
                errors.push({
                  path: op.path,
                  error:
                    '`autoId` requires a COLLECTION path (odd number of segments); got a document path',
                });
                continue;
              }
              target = `${segments.join('/')}/${generateDocId()}`;
              generated.push(target);
            }
            await runtime.adminSetDocument(target, op.data);
            applied++;
          } else {
            // method === 'delete' — `data` field (if any) is silently
            // ignored; the schema documents this so the agent isn't
            // surprised. `adminDeleteDocument` is idempotent: missing
            // path returns `{ deleted: false }` without throwing, but
            // we still count it as "applied" because the OPERATION
            // succeeded (the post-state matches what was requested).
            await runtime.adminDeleteDocument(op.path);
            applied++;
          }
        } catch (e) {
          errors.push({ path: op.path, error: describeError(e) });
        }
      }

      const failed = errors.length;
      const data: SeedResultData = { applied, failed };
      if (failed > 0) data.errors = errors;
      if (generated.length > 0) data.generated = generated;

      const summary =
        failed === 0
          ? `seed_firestore_data_as_admin · applied ${applied}/${operations.length}`
          : `seed_firestore_data_as_admin · applied ${applied}/${operations.length}, ${failed} failed`;

      return {
        // ok=true even with partial failures — the batch RAN, the
        // agent can read `failed` / `errors` and decide how to retry.
        // ok=false is reserved for "tool couldn't be invoked at all"
        // (caps exceeded, malformed args).
        ok: true,
        summary,
        data,
      };
    },
  };
}

type ParsedArgs =
  | { ok: true; operations: SeedOperation[] }
  | { ok: false; summary: string; code: 'TOO_MANY_OPERATIONS' | 'INVALID_ARGS' };

function parseArgs(raw: unknown): ParsedArgs {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      summary: 'expected `{ operations: [...] }`',
      code: 'INVALID_ARGS',
    };
  }
  const a = raw as Partial<SeedArgs>;
  if (!Array.isArray(a.operations)) {
    return {
      ok: false,
      summary: '`operations` must be an array',
      code: 'INVALID_ARGS',
    };
  }
  if (a.operations.length > MAX_OPERATIONS) {
    return {
      ok: false,
      summary: `too many operations (${a.operations.length} > ${MAX_OPERATIONS}). Split across multiple calls.`,
      code: 'TOO_MANY_OPERATIONS',
    };
  }
  // Light shape validation — the per-entry method/path check inside
  // `execute` handles the rest (collected into `errors` per entry so
  // a single bad row doesn't sink the batch).
  const operations: SeedOperation[] = [];
  for (let i = 0; i < a.operations.length; i++) {
    const op = a.operations[i] as unknown;
    if (!op || typeof op !== 'object') {
      return {
        ok: false,
        summary: `operations[${i}] is not an object`,
        code: 'INVALID_ARGS',
      };
    }
    const o = op as Partial<SeedOperation>;
    if (typeof o.path !== 'string' || o.path.length === 0) {
      return {
        ok: false,
        summary: `operations[${i}].path must be a non-empty string`,
        code: 'INVALID_ARGS',
      };
    }
    if (o.method !== undefined && o.method !== 'set' && o.method !== 'delete') {
      return {
        ok: false,
        summary: `operations[${i}].method must be "set" or "delete" (got ${JSON.stringify(o.method)})`,
        code: 'INVALID_ARGS',
      };
    }
    operations.push({
      path: o.path,
      ...(o.data !== undefined ? { data: o.data } : {}),
      ...(o.method !== undefined ? { method: o.method } : {}),
      ...(o.autoId !== undefined ? { autoId: o.autoId } : {}),
    });
  }
  return { ok: true, operations };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
