/**
 * Shared test scaffolding for the canonical `createFirestoreSimulatorTools`
 * factory. Provides a `setup()` per test that builds a fresh
 * `LocalEnvironment` + binds the factory's ToolHandlers to it, plus a
 * legacy-shaped `exec()` adapter that lets the migrated test bodies
 * keep their `{ success, data, error }` assertions unchanged.
 *
 * Why an adapter rather than rewriting every assertion:
 *   - The canonical `ToolHandler` envelope is `{ ok, summary, data }`
 *     where `ok` is sometimes the tool-call outcome and sometimes the
 *     business-outcome (e.g. `firestore_simulator_create_with_auto_id`'s
 *     `ok = result.allowed`, transaction's `ok = result.allowed`).
 *   - Legacy tools always returned `{ success: true, data: { allowed, ... } }`
 *     for executed-but-rule-denied paths, and `{ success: false, error }`
 *     only when validation / parse / module-resolve failed.
 *   - The adapter restores that distinction so the test bodies don't
 *     need to relearn what "success" means per tool.
 *
 * Multi-env model: legacy tools held a `Map<envId, LocalEnvironment>`
 * inside `getAgentTools(app)`'s IIFE, and every call took
 * `environmentId`. The canonical factory binds to one env per
 * `resolveSandbox` resolver — `firestore_simulator_create` re-seeds
 * the resolved env in place. The migrated tests therefore call
 * `setup()` per test to get a fresh env; the `firestore_simulator_create`
 * call inside `seedEnv()` is just a normal seed, no env-creation
 * dance.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createFirestoreSimulatorTools } from '../../../src/rules/simulator.js';

const ABORT_CTX = { signal: new AbortController().signal };

export interface LegacyToolResult {
  success: boolean;
  data?: any;
  error?: { code: string; message: string };
}

/** Tool-level error codes (the canonical factory returns these when a
 *  tool short-circuits before doing real work — input validation,
 *  module-resolve, parse). For these, the adapter surfaces
 *  `{ success: false, error: { code, message } }`. */
const TOOL_FAILURE_CODES = new Set([
  'INVALID_INPUT',
  'NO_MODULE_RESOLVER',
  'PARSE_ERROR',
  'EVAL_ERROR',
  'MODULE_RESOLVE_FAILED',
]);

export async function exec(tool: ToolHandler, params: unknown): Promise<LegacyToolResult> {
  const r = await tool.execute(params as never, ABORT_CTX);
  const data = r.data as
    | { code?: string; allowed?: boolean; error?: { code: string; message: string } }
    | undefined;
  // Tool-level failure shape: short-circuit code AND no business outcome.
  // The transaction tool emits `data: { code: 'INVALID_INPUT' }` with no
  // `allowed` field for shape-validation rejects.
  if (data?.code && data.allowed === undefined && TOOL_FAILURE_CODES.has(data.code)) {
    return { success: false, error: { code: data.code, message: r.summary ?? '' } };
  }
  // Module-resolve failures use the same envelope but the canonical
  // tool also routes them through `ok: false`. Catch the broader case
  // by looking at `r.ok` when no business outcome is present.
  if (!r.ok && data && !('allowed' in data) && !('lint' in data) && !('document' in data) && !('documents' in data) && !('event' in data) && !('events' in data) && !('undone' in data) && !('redone' in data) && !('results' in data) && !('path' in data)) {
    const code = data?.code ?? data?.error?.code ?? 'TOOL_ERROR';
    const message = data?.error?.message ?? r.summary ?? 'tool error';
    return { success: false, error: { code, message } };
  }
  // Otherwise the tool ran — preserve the canonical payload under
  // legacy `data`. Rule-denied writes etc. surface as
  // `{ success: true, data: { allowed: false, ... } }`.
  return { success: true, data: r.data };
}

export interface SimulatorRegistry {
  get(name: string): ToolHandler;
  env: LocalEnvironment;
}

export function setup(): SimulatorRegistry {
  const env = new LocalEnvironment();
  const tools = createFirestoreSimulatorTools({ resolveSandbox: () => env });
  return {
    env,
    get(name: string): ToolHandler {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`tool not registered: ${name}`);
      return t;
    },
  };
}

/**
 * Seed the registry's env via `firestore_simulator_create` (re-seeds
 * the bound env in place — the legacy `environmentId` is gone). Returns
 * the seed call's lint result for tests that care.
 */
export async function seedEnv(
  reg: SimulatorRegistry,
  opts: { rules?: string; documents?: Record<string, Record<string, unknown>> },
): Promise<unknown> {
  const result = await exec(reg.get('firestore_simulator_create'), {
    rules: opts.rules ?? OPEN_RULES,
    documents: opts.documents ?? {},
  });
  if (!result.success) {
    throw new Error('failed to seed env: ' + JSON.stringify(result));
  }
  return result.data;
}

export const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
