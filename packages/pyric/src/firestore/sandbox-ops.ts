/**
 * `pyric/firestore` — sandbox-only lifecycle operations.
 *
 * The `sandbox` named-object export (`setRules` / `seedDocuments` /
 * `snapshotState` / `inspect`) that has no `firebase/firestore` analog, and
 * the `inspect` diagnostic's stable JSON shape. Each op throws
 * `SandboxError` when handed a prod-target handle.
 */
import {
  SandboxError,
  type DocumentData,
  type LintResult,
} from 'pyric/sandbox/admin-firestore';
import type { Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { lintFirestoreRules } from 'pyric/rules/internal';

import {
  targetOf,
  isSandboxKind,
  sandboxDb,
} from './state.js';
import type { Firestore } from './types.js';

// ─── Sandbox-only operations ──────────────────────────────────────────
//
// Grouped as a named-object export per the v4 plan. These have no
// `firebase/firestore` analog — keeping them under a `sandbox`
// namespace at the import site documents the sandbox-only
// constraint better than the runtime throw could. Calling them on
// a prod-target Firestore still throws `SandboxError` defensively.

/**
 * Sandbox lifecycle operations. Only meaningful against a
 * sandbox-target `Firestore` (built via `getFirestore(ctx)` with a
 * `SandboxContext`). Each function throws `SandboxError` when
 * handed a prod-target handle.
 *
 * **Naming note**: the `sandbox` export name conflicts with the
 * common local variable from `initializeSandbox()` (which also
 * returns a `Sandbox` typically held as `const sandbox = …`).
 * When both are in scope, alias the import:
 *
 * ```ts
 * import { sandbox as sandboxOps } from 'pyric/firestore';
 * import { initializeSandbox } from 'pyric/sandbox';
 *
 * const sandbox = initializeSandbox();      // local var
 * const db = getFirestore(sandbox.withAuth(…));
 * sandboxOps.setRules(db, RULES);            // SDK ops
 * ```
 *
 * The `sandbox` name was kept because it accurately describes the
 * surface (sandbox-only lifecycle). The renaming alternatives —
 * `sbx`, `firestoreSandbox`, `localOps` — all read worse than the
 * import-time alias.
 */
export const sandbox = {
  /** Load a rules source into the underlying `LocalEnvironment`. */
  setRules(db: Firestore, rules: string): LintResult {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.setRules is sandbox-only; deploy production rules with the Firebase CLI.',
      );
    }
    return sandboxDb(target).setRules(rules);
  },
  /** Bulk-load documents bypassing rules. */
  seedDocuments(
    db: Firestore,
    documents: Record<string, DocumentData>,
  ): LintResult {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.seedDocuments is sandbox-only; populate prod data via writes.',
      );
    }
    return sandboxDb(target).seed({ documents });
  },
  /** Dump every document the underlying `LocalEnvironment` has stored. */
  snapshotState(db: Firestore): Record<string, DocumentData> {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.snapshotState is sandbox-only.',
      );
    }
    return sandboxDb(target).snapshot();
  },
  /**
   * Single-call diagnostic an agent uses to answer "what state is the
   * sandbox in?" without grepping internal modules. Born out of
   * CLAUDE_DEBUG_SESSION.md: a real agent took 51 tool calls + 72k
   * tokens to figure out that the scaffold's rules weren't loaded.
   *
   * Returns: current rules source, lint summary, doc count by
   * collection, recent denials, recent requests. Stable JSON shape —
   * marshalled over MCP by `sandbox_inspect`.
   */
  inspect(db: Firestore, opts?: { recentEventLimit?: number }): SandboxInspect {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.inspect is sandbox-only.',
      );
    }
    return inspectSandbox(target.sandbox, opts?.recentEventLimit ?? 10);
  },
};

/**
 * Shape returned by {@link sandbox.inspect}. Stable JSON-serializable
 * surface — agents marshal this over MCP.
 */
export interface SandboxInspect {
  rules: {
    source: string;
    sizeBytes: number;
    isEmpty: boolean;
    lint: {
      errors: number;
      warnings: number;
      info: number;
      findings: Array<{ rule: string; severity: string; message: string }>;
    };
  };
  documents: {
    totalCount: number;
    byCollection: Record<string, number>;
  };
  events: {
    totalCount: number;
    recentDenials: Array<{ path: string; method: string; auth: unknown; debugMessage?: string }>;
    recentRequests: Array<{ path: string; method: string; result: string; auth: unknown }>;
  };
}

function inspectSandbox(sandbox: Sandbox, recentLimit: number): SandboxInspect {
  const env = getInternalEnv(sandbox);
  const rulesSource = env.getRules();
  const lint = rulesSource ? lintFirestoreRules(rulesSource) : { warnings: [] };
  const findings = lint.warnings.map((w) => ({
    rule: w.rule,
    severity: w.severity,
    message: w.message,
  }));
  const counts = { errors: 0, warnings: 0, info: 0 };
  for (const w of lint.warnings) {
    if (w.severity === 'error') counts.errors++;
    else if (w.severity === 'warning') counts.warnings++;
    else counts.info++;
  }

  const docs = env.snapshot();
  const byCollection: Record<string, number> = {};
  for (const path of Object.keys(docs)) {
    const top = path.split('/')[0] ?? '';
    if (!top) continue;
    byCollection[top] = (byCollection[top] ?? 0) + 1;
  }

  const history = sandbox.history() as unknown as Array<Record<string, unknown>>;
  const requests = history.filter((e) => e.kind === 'request');
  const denials = requests.filter((e) => e.result === 'deny');
  const recentRequests = requests.slice(-recentLimit).map((e) => ({
    path: String(e.path ?? ''),
    method: String(e.method ?? ''),
    result: String(e.result ?? ''),
    auth: e.auth ?? null,
  }));
  const recentDenials = denials.slice(-recentLimit).map((e) => ({
    path: String(e.path ?? ''),
    method: String(e.method ?? ''),
    auth: e.auth ?? null,
    debugMessage: typeof e.debugMessage === 'string' ? e.debugMessage : undefined,
  }));

  return {
    rules: {
      source: rulesSource,
      sizeBytes: new TextEncoder().encode(rulesSource).byteLength,
      isEmpty: rulesSource.trim().length === 0,
      lint: { ...counts, findings },
    },
    documents: {
      totalCount: Object.keys(docs).length,
      byCollection,
    },
    events: {
      totalCount: history.length,
      recentDenials,
      recentRequests,
    },
  };
}
