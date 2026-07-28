/**
 * `createFirestoreSimulatorTools` factory — extracted from `tools.ts`
 * so it can run in both Node and the browser without forcing the
 * Node-only `resolveModules` (which reads stdlib off disk) into the
 * browser bundle.
 *
 * The factory takes `resolveModulesFn` as an injected dep:
 *  - `pyric/rules/internal/node` wires `resolveModules` from `./modules/resolver.js`
 *    — Node's disk-reading version.
 *  - `./simulator.ts` wires `resolveModulesBrowser` from
 *    `./modules/resolver-browser.js`, which pre-supplies the stdlib content
 *    inlined at build time.
 *  - When the dep is absent, the `firestore_simulator_create` tool
 *    returns a clear error if a caller seeds `'2+modules'` rules.
 *
 * Why this matters: prior to the extraction, `@pyric/dev`'s browser
 * client hand-coded a parallel dispatcher that mirrored these tool
 * shapes. Any new simulator tool added to `tools.ts` silently
 * diverged from the dispatcher. Now both sides consume this single
 * source of truth.
 */

import type { ToolHandler } from '@inbrowser/agent';
import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type { ResolveResult } from './modules/resolver.js';
import {
  resolveExpressionsInData,
  ExpressionWalkError,
} from './simulator/expression/walk-data.js';
import {
  ExpressionLexError,
  ExpressionParseError,
} from './simulator/expression/types.js';
import { EvalError } from './simulator/expression/eval-errors.js';

export interface FirestoreSimulatorToolDeps {
  /**
   * Per-dispatch resolver returning the session's LocalEnvironment.
   * Per F4, handlers call this inside `execute` — hosts that reset
   * or swap the sandbox transparently get fresh environments
   * without re-registering tools.
   *
   * For sessions that need a single long-lived env, the host can
   * pass `() => singletonEnv`; for fleets that isolate per-session,
   * `() => sessionContext.env`.
   */
  resolveSandbox: () => LocalEnvironment | Promise<LocalEnvironment>;
  /**
   * Resolver for `rules_version = '2+modules'` sources. Wire one of:
   *   - `resolveModules` from `./modules/resolver.js` (Node; disk).
   *   - `resolveModulesBrowser` from `./modules/resolver-browser.js`
   *     (browser; inlined stdlib).
   * When absent, attempts to seed `2+modules` rules error cleanly.
   */
  resolveModulesFn?: (source: string) => ResolveResult;
}

/**
 * Stateful simulator tools — operate against a session-scoped
 * `LocalEnvironment`. The nine-tool family — `_create`, `_execute`,
 * `_read`, `_batch`, `_create_with_auto_id`, `_undo`, `_redo`,
 * `_events`, `_transaction` — is the factory-shaped simulator tool group.
 *
 * Key shape difference vs legacy: there is no `environmentId`. In
 * factory mode the resolved `LocalEnvironment` IS the environment —
 * one per session. Hosts that need multi-env semantics can layer
 * registry/context above the resolver. `firestore_simulator_create`
 * therefore acts as a re-seed: it overwrites whatever the resolved
 * env held before.
 *
 * `resolveSandbox` is awaited inside each handler so hosts that swap
 * environments transparently (per-session fleets, hot-reload pipes)
 * get fresh refs without re-registering tools.
 */
export function createFirestoreSimulatorTools(
  deps: FirestoreSimulatorToolDeps,
): ToolHandler[] {
  const { resolveSandbox, resolveModulesFn } = deps;
  return [
    {
      name: 'firestore_simulator_create',
      description:
        'Seed the session\'s local Firestore environment with rules and optional initial documents. Resets any prior state. Supports `rules_version = "2+modules"` — modules resolve in-process before seeding. Returns the lint result + document count for verification.',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'string',
            description: 'Firestore security rules source (version 2 or 2+modules).',
          },
          documents: {
            type: 'object',
            description: 'Initial documents keyed by full path, e.g. `{ "users/u1": { name: "alice" } }`.',
            additionalProperties: true,
          },
        },
        required: ['rules'],
      },
      async execute(args) {
        const { rules: rulesIn, documents } = args as {
          rules: string;
          documents?: Record<string, Record<string, unknown>>;
        };
        let rules = rulesIn;
        if (rules.includes("'2+modules'") || rules.includes('"2+modules"')) {
          if (!resolveModulesFn) {
            return {
              ok: false,
              summary:
                'Module resolve unavailable: this builder was not wired with `resolveModulesFn`. Use a package entry that wires module resolution, such as pyric/rules/internal/node, instead of importing the impl directly.',
              data: { code: 'NO_MODULE_RESOLVER' },
            };
          }
          const resolved = resolveModulesFn(rules);
          if (!resolved.success) {
            return {
              ok: false,
              summary: `Module resolve failed: ${resolved.error.message}`,
              data: resolved,
            };
          }
          rules = resolved.data.resolved;
        }
        const env = await resolveSandbox();
        const lint = env.seed({ rules, documents: documents ?? {} });
        return {
          ok: true,
          summary: `Seeded sandbox with ${Object.keys(documents ?? {}).length} document(s)`,
          data: { lint, documentCount: Object.keys(documents ?? {}).length },
        };
      },
    },
    {
      name: 'firestore_simulator_execute',
      description:
        'Execute a single write (create / update / delete) against the seeded sandbox. Rules evaluate against the in-memory state; allow → state mutates and the op is logged, deny → state unchanged and `debugMessages` explain the rule decision.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['create', 'update', 'delete'] },
          path: { type: 'string', description: 'Document path, e.g. `users/u1`.' },
          auth: {
            description:
              'Auth context. `null` for unauthenticated. Otherwise `{ uid, token? }` where `token` is the custom-claims object.',
          },
          data: {
            type: 'object',
            description: 'Document data. Required for create / update.',
            additionalProperties: true,
          },
        },
        required: ['method', 'path', 'auth'],
      },
      async execute(args) {
        const { method, path, auth, data } = args as {
          method: 'create' | 'update' | 'delete';
          path: string;
          auth: { uid: string; token?: Record<string, unknown> } | null;
          data?: Record<string, unknown>;
        };
        const env = await resolveSandbox();
        const result = env.execute({ method, path, auth, data });
        return {
          ok: result.allowed,
          summary: result.allowed
            ? `${method} on ${path} allowed`
            : `${method} on ${path} denied`,
          data: { allowed: result.allowed, debugMessages: result.debugMessages },
        };
      },
    },
    {
      name: 'firestore_simulator_read',
      description:
        'Read a document (`get`) or list a collection (`list`) from the seeded sandbox. Default uses admin access (bypasses rules). Set `evaluateRules: true` with an `auth` context to test read access control through the rules engine.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Doc path for `get`, collection path for `list`.' },
          method: { type: 'string', enum: ['get', 'list'], description: 'Default `get`.' },
          auth: {
            description: 'Auth context. Required when `evaluateRules` is true.',
          },
          evaluateRules: {
            type: 'boolean',
            description: 'Evaluate read rules against `auth`. Default false (admin read).',
          },
        },
        required: ['path'],
      },
      async execute(args) {
        const { path, method, auth, evaluateRules } = args as {
          path: string;
          method?: 'get' | 'list';
          auth?: { uid: string; token?: Record<string, unknown> } | null;
          evaluateRules?: boolean;
        };
        const env = await resolveSandbox();
        if (evaluateRules) {
          const result = env.execute({ method: method ?? 'get', path, auth: auth ?? null });
          return {
            ok: result.allowed,
            summary: result.allowed
              ? `${method ?? 'get'} on ${path} allowed`
              : `${method ?? 'get'} on ${path} denied`,
            data: {
              allowed: result.allowed,
              document: result.data,
              debugMessages: result.debugMessages,
            },
          };
        }
        if (method === 'list') {
          return {
            ok: true,
            summary: `Listed ${path}`,
            data: { documents: env.listDocuments(path) },
          };
        }
        return {
          ok: true,
          summary: `Read ${path}`,
          data: { document: env.getDocument(path) },
        };
      },
    },
    {
      name: 'firestore_simulator_batch',
      description:
        'Execute multiple writes atomically. All operations must pass rules — if any denies, none apply. Rules evaluate each op against pre-batch state (no cross-visibility within the batch).',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['create', 'update', 'delete'] },
                path: { type: 'string' },
                data: { type: 'object', additionalProperties: true },
              },
              required: ['method', 'path'],
            },
          },
          auth: {
            description: 'Auth context for every op. `null` for unauthenticated.',
          },
        },
        required: ['operations', 'auth'],
      },
      async execute(args) {
        const { operations, auth } = args as {
          operations: Array<{
            method: 'create' | 'update' | 'delete';
            path: string;
            data?: Record<string, unknown>;
          }>;
          auth: { uid: string; token?: Record<string, unknown> } | null;
        };
        const env = await resolveSandbox();
        const result = env.batch(operations, auth);
        return {
          ok: result.allowed,
          summary: result.allowed
            ? `Batch of ${operations.length} op(s) committed`
            : `Batch of ${operations.length} op(s) rejected by rules. To SEED data, use the admin data tool firestore_batch_write; to test rules, pass an auth the rules permit.`,
          data: { allowed: result.allowed, results: result.results },
        };
      },
    },
    {
      name: 'firestore_create_with_auto_id',
      description:
        'Create a document at `<collection>/<auto-id>` with a Firestore-compatible 20-char alphanumeric id (mirrors the live SDK `addDoc()` flow). Rules evaluate as for an explicit-id `create`. Returns the minted path so the caller can re-read the doc without a side channel.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection path under which to mint the new document, e.g. `users` or `users/u1/posts`.',
          },
          auth: {
            description:
              'Auth context. `null` for unauthenticated. Otherwise `{ uid, token? }`.',
          },
          data: {
            type: 'object',
            description: 'Document data.',
            additionalProperties: true,
          },
        },
        required: ['collection', 'auth', 'data'],
      },
      async execute(args) {
        const { collection, auth, data } = args as {
          collection: string;
          auth: { uid: string; token?: Record<string, unknown> } | null;
          data: Record<string, unknown>;
        };
        const env = await resolveSandbox();
        const { path, result } = env.createWithAutoId(collection, data, auth);
        return {
          ok: result.allowed,
          summary: result.allowed
            ? `Created ${path}`
            : `Create at ${path} denied by rules (as ${auth ? auth.uid : 'unauthenticated'}). To SEED data, use the admin data tool firestore_add_document; to test rules, pass an auth the rules permit.`,
          data: {
            path,
            allowed: result.allowed,
            debugMessages: result.debugMessages,
          },
        };
      },
    },
    {
      name: 'firestore_simulator_undo',
      description:
        'Undo the last allowed write. Restores state to immediately before that op. Returns the undone event, or a `{ undone: false }` outcome when the log is empty.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const env = await resolveSandbox();
        const event = env.undo();
        if (!event) {
          return { ok: true, summary: 'Nothing to undo', data: { undone: false } };
        }
        return {
          ok: true,
          summary: `Undid ${event.method} on ${event.path}`,
          data: { undone: true, event: { method: event.method, path: event.path } },
        };
      },
    },
    {
      name: 'firestore_simulator_redo',
      description:
        'Re-apply the most recently undone write. Pairs with `firestore_simulator_undo`. Returns the re-applied event, or `{ redone: false }` when the undo stack is empty (no recent undo to redo).',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const env = await resolveSandbox();
        const result = env.redo();
        if (!result) {
          return { ok: true, summary: 'Nothing to redo', data: { redone: false } };
        }
        return {
          ok: result.allowed,
          summary: result.allowed
            ? `Redid ${result.event?.method ?? 'op'} on ${result.event?.path ?? '?'}`
            : 'Redo restored a denied event (no state change)',
          data: {
            redone: true,
            allowed: result.allowed,
            event: result.event
              ? { method: result.event.method, path: result.event.path }
              : null,
            debugMessages: result.debugMessages,
          },
        };
      },
    },
    {
      name: 'firestore_simulator_events',
      description:
        'Return every event the sandbox has seen — allowed and denied — with timestamps, auth, and debug messages. Useful for audit / replay / "why did this rule deny?" investigations.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const env = await resolveSandbox();
        return {
          ok: true,
          summary: 'Event log',
          data: {
            events: env.getEvents().map((e) => ({
              id: e.id,
              method: e.method,
              path: e.path,
              allowed: e.allowed,
              auth: e.auth,
              debugMessages: e.debugMessages,
            })),
          },
        };
      },
    },
    {
      name: 'firestore_simulator_transaction',
      description:
        'Run a declarative transaction. Reads are captured server-side and referenced from write data via `{ "$expr": "..." }` wrappers — agents never see the read values, eliminating the "round-trip the doc through context" cost. Expression DSL: arithmetic (+ - * / %), comparison, &&/||/?:, $alias.field references, string literals in either "double" or \'single\' quotes, and @sentinel(...) calls (@increment, @serverTimestamp, @arrayUnion, @arrayRemove, @deleteField). Reads are omitted from the response by default; set `includeReads: true` when debugging a denial.',
      parameters: {
        type: 'object',
        properties: {
          auth: {
            description: 'Auth context for rule eval. `null` for unauthenticated.',
          },
          readOnly: {
            type: 'boolean',
            description: 'Hint that the transaction is read-only. v1: writes are still committed; `readOnlyViolation: true` surfaces on the response if any was queued.',
          },
          includeReads: {
            type: 'boolean',
            description: 'Default false. When true, the response includes the captured read data + per-write debugMessages.',
          },
          reads: {
            type: 'object',
            description: 'Reads keyed by alias. Aliases referenced from write expressions as `$alias` (e.g. `$src.balance`).',
            additionalProperties: { type: 'string' },
          },
          writes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['create', 'update', 'set', 'delete'] },
                path: { type: 'string' },
                data: { type: 'object', additionalProperties: true },
              },
              required: ['method', 'path'],
            },
            description: 'Write operations to apply atomically.',
          },
        },
        required: ['reads', 'writes', 'auth'],
      },
      async execute(args) {
        const { auth, readOnly, includeReads, reads, writes } = args as {
          auth: { uid: string; token?: Record<string, unknown> } | null;
          readOnly?: boolean;
          includeReads?: boolean;
          reads: Record<string, string>;
          writes: Array<{
            method: 'create' | 'update' | 'set' | 'delete';
            path: string;
            data?: Record<string, unknown>;
          }>;
        };

        // Validate method-conditional `data` requirement (JSON Schema
        // can't express it cleanly).
        for (let i = 0; i < writes.length; i += 1) {
          const w = writes[i];
          if (w.method === 'delete' && w.data !== undefined) {
            return {
              ok: false,
              summary: `writes[${i}]: 'delete' must not include 'data'`,
              data: { code: 'INVALID_INPUT' },
            };
          }
          if (w.method !== 'delete' && w.data === undefined) {
            return {
              ok: false,
              summary: `writes[${i}]: '${w.method}' requires 'data'`,
              data: { code: 'INVALID_INPUT' },
            };
          }
        }

        const env = await resolveSandbox();
        const showReads = includeReads === true;
        try {
          const result = env.transaction((tx) => {
            const readsEnv: Record<string, Record<string, unknown> | null> = {};
            for (const [alias, path] of Object.entries(reads)) {
              const snap = tx.get(path);
              const d = snap.data();
              readsEnv[alias] = d === undefined ? null : (d as Record<string, unknown>);
            }
            for (let i = 0; i < writes.length; i += 1) {
              const w = writes[i];
              if (w.method === 'delete') {
                tx.delete(w.path);
                continue;
              }
              const resolved = resolveExpressionsInData(
                w.data as Record<string, unknown>,
                { reads: readsEnv },
              );
              if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
                throw new ExpressionWalkError(
                  `writes[${i}].data resolved to a non-object`,
                  `writes.${i}.data`,
                );
              }
              const data = resolved as Record<string, unknown>;
              switch (w.method) {
                case 'create': tx.create(w.path, data); break;
                case 'update': tx.update(w.path, data); break;
                case 'set':    tx.set(w.path, data);    break;
              }
            }
          }, { auth, readOnly });

          const response: Record<string, unknown> = {
            allowed: result.allowed,
            writes: result.writes.map((w) => {
              const entry: Record<string, unknown> = {
                path: w.path,
                method: w.method,
                allowed: w.allowed,
              };
              if (w.error) entry.error = { code: w.error.code, message: w.error.message };
              if (showReads) entry.debugMessages = w.debugMessages;
              return entry;
            }),
          };
          if (result.error) {
            response.error = { code: result.error.code, message: result.error.message };
          }
          if (result.readOnlyViolation) {
            response.readOnlyViolation = true;
          }
          if (showReads) {
            response.reads = result.reads.map((r) => ({ path: r.path, data: r.data }));
          }
          return {
            ok: result.allowed,
            summary: result.allowed
              ? `Transaction committed (${writes.length} write(s))`
              : `Transaction rolled back`,
            data: response,
          };
        } catch (e) {
          if (
            e instanceof ExpressionWalkError ||
            e instanceof ExpressionLexError ||
            e instanceof ExpressionParseError ||
            e instanceof EvalError
          ) {
            return {
              ok: false,
              summary: `Transaction failed: ${e.message}`,
              data: {
                allowed: false,
                writes: [],
                error: { code: 'invalid-argument', message: e.message },
              },
            };
          }
          // Unknown throw — propagate so we don't swallow bugs.
          throw e;
        }
      },
    },
  ];
}
