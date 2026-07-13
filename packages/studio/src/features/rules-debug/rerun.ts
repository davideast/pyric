/**
 * Rules-failure debugging: the two re-run paths (Pyric Studio F4).
 *
 * A denied op is only half the story; the point of F4 is to let you *re-run* it
 * and watch the decision flip. Two paths (Firestore only today — see `SPEC.md`
 * for RTDB/Storage's `pending`/`absent` gating):
 *
 *   1. RE-RUN AS THE ATTEMPTING USER ("impersonate"): issue the same op under
 *      the impersonation lens (`{ mode: 'as', uid }`) so security rules evaluate
 *      as the user who hit the denial, and report allow/deny. This is wired to
 *      the live worker via the client's `setLens` seam (the impersonation lens
 *      already merged: T2). See {@link rerunAsUser}.
 *
 *   2. RE-RUN AGAINST AN EDITED RULESET ("what if"): lint the candidate ruleset
 *      first (`firestore_lint_rules`), then `fork(snapshot, editedRules)` gives
 *      an isolated sandbox seeded with the SAME data but the EDITED rules;
 *      re-issue the op there (as the attempting user) and report the result plus
 *      a structural `diff` of what the (now-allowed) write changed vs live. This
 *      is fully self-contained (no worker, no live mutation), so it's pure and
 *      unit-testable. See {@link rerunAgainstRules}.
 *
 * Path (2) is the richer one and the reason F4 reuses the branches primitive.
 */

import {
  fork,
  diff,
  discard,
  type AuthState,
  type Divergence,
  type LocalSandbox,
  type Sandbox,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import {
  getFirestore as getSandboxFirestore,
  doc,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  getDoc,
  getDocs,
  query,
  SandboxError,
} from 'pyric/firestore';
import { lintFirestoreRules, type LintWarning } from 'pyric/rules/internal';
import type { Denial } from './model.js';

/** Outcome of a single re-run: did the rule allow it this time, or deny again? */
export type RerunResult =
  | { outcome: 'allow' }
  | { outcome: 'deny'; code: string; message: string; reasons?: string[] }
  | { outcome: 'error'; code: string; message: string };

/** One lint finding, flattened for display (drops AST-position internals). */
export interface RulesetLintFinding {
  rule: string;
  severity: LintWarning['severity'];
  message: string;
  fix?: string;
}

/**
 * The result of linting a candidate ruleset before an edited-ruleset re-run,
 * grounded in `firestore_lint_rules` (`lintFirestoreRules`).
 *
 * `parseError` is the ONLY hard blocker: an unparseable ruleset cannot be
 * forked/simulated, so the re-run short-circuits and reports it. `findings`
 * (including security-level `severity:'error'` lints such as
 * `RECURSIVE_WILDCARD_OPEN`) are SURFACED but do NOT block — the whole point of
 * the edited-ruleset re-run is to try loose candidate rules and watch the
 * decision flip, so we run and let the user see both the flip and the lint.
 */
export interface RulesetLint {
  /** True when the ruleset parses (the re-run may proceed). */
  parseable: boolean;
  /** Human-readable parse failure, when `parseable` is false. */
  parseError?: string;
  /** All lint findings (both `warning` and `error` severities). */
  findings: RulesetLintFinding[];
}

/**
 * Lint a candidate ruleset the way `firestore_lint_rules` does. Pure — safe to
 * call from the UI to annotate the editor live, and called by
 * {@link rerunAgainstRules} before it forks.
 */
export function lintEditedRuleset(rules: string): RulesetLint {
  const result = lintFirestoreRules(rules);
  const findings: RulesetLintFinding[] = result.warnings.map((w) => ({
    rule: w.rule,
    severity: w.severity,
    message: w.message,
    ...(w.fix ? { fix: w.fix } : {}),
  }));
  if (result.parseError) {
    return {
      parseable: false,
      parseError: result.parseError.message,
      findings,
    };
  }
  return { parseable: true, findings };
}

/** A re-run against an edited ruleset, with the structural delta it produced. */
export interface EditedRulesetRerun {
  result: RerunResult;
  /** Doc-level + field-level differences the re-issued op produced vs `live`.
   *  Empty when the op denied again (nothing changed) or was a read. */
  diff: Divergence[];
  /** Lint findings for the candidate ruleset (surfaced, not blocking unless the
   *  ruleset failed to parse). Always present so the UI can render the lint pass. */
  lint: RulesetLint;
}

/**
 * Re-issue a denied op against an EDITED ruleset, in an isolated branch.
 *
 * Lints the candidate ruleset first (`firestore_lint_rules`), forks a sandbox
 * from `snapshot` seeded with `editedRules`, re-issues the denial's op AS the
 * user who attempted it (so `request.auth.uid` matches what the original eval
 * saw), and returns whether the edited rules now allow it, plus a `diff` of the
 * branch vs `live` (what the op changed). The branch is always discarded: this
 * is a read-only "what if", never a live mutation.
 *
 * Pure + synchronous-in-spirit (the firestore ops are async but operate entirely
 * on the in-memory fork). Safe to call from a test with no browser.
 *
 * @param snapshot   Baseline data (typically `liveSandbox.snapshot()`).
 * @param denial     The op to reproduce.
 * @param editedRules The candidate ruleset to test.
 * @param live        Diff reference: the live sandbox/snapshot to compare against.
 */
export async function rerunAgainstRules(
  snapshot: SandboxSnapshot,
  denial: Denial,
  editedRules: string,
  live: LocalSandbox | SandboxSnapshot,
): Promise<EditedRulesetRerun> {
  // Lint first (firestore_lint_rules). A parse failure is the only hard blocker
  // — an unparseable ruleset can't be forked/simulated — so short-circuit and
  // report it rather than throwing an opaque fork error. Non-parse findings
  // (including security-level lints) are surfaced but do not block the run.
  const lint = lintEditedRuleset(editedRules);
  if (!lint.parseable) {
    return {
      result: {
        outcome: 'error',
        code: 'lint-parse-error',
        message: lint.parseError ?? 'The edited ruleset did not parse.',
      },
      diff: [],
      lint,
    };
  }

  const branch = fork(snapshot, editedRules);
  try {
    const result = await issueOp(branch.sandbox, denial);
    // Only a mutation that actually landed can diverge; a denied/read op leaves
    // the branch identical to its base, so `diff` is naturally empty there.
    const divergences = result.outcome === 'allow' ? diff(branch, live) : [];
    return { result, diff: divergences, lint };
  } finally {
    discard(branch);
  }
}

/**
 * Re-issue a denied op AS the attempting user, against an arbitrary sandbox,
 * and classify the outcome. Shared by {@link rerunAgainstRules} (on the fork)
 * and usable directly against a live sandbox for an admin-driven reproduce.
 *
 * The op runs through a frozen-identity handle (`sandbox.withAuth(auth)`), so
 * rules evaluate exactly as they did for the original attempt. A
 * `permission-denied` `SandboxError` becomes `{ outcome: 'deny', ... }` carrying
 * the fresh denial reasons; any other throw is `{ outcome: 'error' }`.
 */
export async function issueOp(sandbox: Sandbox, denial: Denial): Promise<RerunResult> {
  const db = getSandboxFirestore(sandbox.withAuth(denial.auth as AuthState));
  const resourceData = documentData(denial.resourceData);
  try {
    switch (denial.method) {
      case 'get':
        await getDoc(doc(db, denial.path));
        break;
      case 'list':
      case 'listen':
        // A list/query denial reproduces as a COLLECTION read, not a doc read.
        // The denial's `path` is the collection (odd segment count), so
        // `doc(db, path)` would throw INVALID-ARGUMENT ("document path must have
        // an even number of segments") — a raw SDK shape error, never a rules
        // verdict. `getDocs(query(collection(...)))` issues the right op shape so
        // the re-run reflects the actual list rule decision.
        await getDocs(query(collection(db, denial.path)));
        break;
      case 'create':
      case 'set':
        await setDoc(doc(db, denial.path), resourceData);
        break;
      case 'update':
        await updateDoc(doc(db, denial.path), resourceData);
        break;
      case 'delete':
        await deleteDoc(doc(db, denial.path));
        break;
      default:
        // Defensive: an addDoc-style auto-id create reproduces against the parent.
        await addDoc(collection(db, parentCollection(denial.path)), resourceData);
    }
    return { outcome: 'allow' };
  } catch (e) {
    if (e instanceof SandboxError && e.code === 'permission-denied') {
      const reasons = e.denialContext?.reasons;
      return { outcome: 'deny', code: e.code, message: e.message, ...(reasons ? { reasons } : {}) };
    }
    const code = e instanceof SandboxError ? e.code : 'unknown';
    return { outcome: 'error', code, message: e instanceof Error ? e.message : String(e) };
  }
}

function documentData(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parentCollection(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(0, i);
}

// ─── Impersonation re-run (live worker, via the client's setLens seam) ──────

/**
 * The worker-client surface {@link rerunAsUser} needs. The studio app passes the
 * real `@pyric/cli` worker client here; tests pass a fake. Kept as a narrow
 * structural type so this module doesn't hard-depend on the worker client (which
 * pulls in the SharedWorker path): it depends only on the `setLens` + a doc-read
 * shape it already exposes.
 */
export interface ImpersonationClient {
  /** Set the per-op auth lens applied to subsequent data ops. */
  setLens(lens: { mode: 'as'; uid: string } | { mode: 'app-session' } | undefined): void;
  /** Issue the denied op under the currently-set lens; resolves on allow,
   *  rejects with a `{ code }` error on deny. The app adapter implements this
   *  by dispatching on `denial.method` to the client's getDoc/setDoc/etc. */
  reissue(denial: Denial): Promise<void>;
}

/**
 * Re-run a denied op AS the attempting user against the LIVE worker sandbox.
 *
 * Sets the impersonation lens (`{ mode: 'as', uid }`) for the user the original
 * op ran as, re-issues the op through the worker, and reports allow/deny, then
 * restores the prior lens. This is the live counterpart to {@link rerunAgainstRules}:
 * same rules, but evaluated as the user (the rules-debugging primitive), against
 * the real backend rather than a fork.
 *
 * Requires the denial to have a concrete `auth.uid`: an anonymous (`null`)
 * denial has no user to impersonate, so we report that explicitly rather than
 * silently running as the app session.
 */
export async function rerunAsUser(
  client: ImpersonationClient,
  denial: Denial,
): Promise<RerunResult> {
  const uid = denial.auth?.uid;
  if (!uid) {
    return {
      outcome: 'error',
      code: 'no-user',
      message:
        'This op was attempted anonymously (request.auth was null): there is no user to impersonate. Try the edited-ruleset re-run instead.',
    };
  }
  client.setLens({ mode: 'as', uid });
  try {
    await client.reissue(denial);
    return { outcome: 'allow' };
  } catch (e) {
    const err = e as { code?: string; message?: string; reasons?: string[] };
    const code = err.code ?? 'unknown';
    if (code === 'permission-denied') {
      return {
        outcome: 'deny',
        code,
        message: err.message ?? 'permission denied',
        ...(err.reasons ? { reasons: err.reasons } : {}),
      };
    }
    return { outcome: 'error', code, message: err.message ?? String(e) };
  } finally {
    // Restore the app's own session lens: impersonation is a momentary probe.
    client.setLens({ mode: 'app-session' });
  }
}
