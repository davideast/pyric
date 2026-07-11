/**
 * Host-side write-validation gates (Track C, phase C1).
 *
 * The inversion the efficiency epic proved: the HOST validates, the agent
 * repairs. Instead of spending model turns deciding *whether* to lint or
 * re-simulate after a write, `write_file` runs these gates in-host
 * (post-write, post-deploy) and returns the evidence in a structured
 * `validation` block on the tool result.
 *
 * Binding design constraints (plans/agent-capability-epic/00-autonomous-plan.md section C1):
 *   - Gates REPORT, they never block. The write has already landed when a
 *     gate runs; failures come back as evidence for the agent's next turn.
 *   - Gate failures (lint crash, esbuild unavailable, replay throw) degrade
 *     to write-without-validation — `gateError` is set, the write succeeds.
 *
 * Two gates:
 *   - RULES (`/workspace/firestore.rules`): lint the deployed (resolved)
 *     source + the `try_rules_edit` two-phase verifier over the sandbox's
 *     captured history — previously-succeeded writes that the new rules
 *     now deny are `regressions`; previously-denied requests are split
 *     into `unblocked` (count) and `stillDenied` (informational — they may
 *     be *intended* denials).
 *   - APP (`*.tsx` / `*.ts`): compile. In the browser the preview entry
 *     compiles through the real `compileApp` pipeline (bundling, import
 *     resolution); other modules get an esbuild syntax-level transform.
 *     In Node (headless harness) the browser service can't load, so the
 *     gate falls back to a direct `esbuild-wasm` transform (syntax-level).
 *
 * Token economy: validation entries are compact strings/objects and the
 * arrays are capped (`CAP`) — the block rides back in the tool result and
 * is re-sent in history every subsequent model call.
 */
import {
  lintFirestoreRules,
  SimulateFirestoreRulesHandler,
  type LintWarning,
  type TestCase,
} from 'pyric/rules/internal';
import { replay, type SandboxEvent } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import { APP_ENTRY_PATH } from '~/lib/store/files';
import {
  classifyRegressions,
  partitionEvents,
  requestEventToTestCase,
} from '../diagnostics/try-rules-edit.shared';

/** Cap per validation array — the block is re-sent in history on every
 *  subsequent model call, so unbounded lists would re-introduce the
 *  accumulation problem the epic fixed (#515). */
const CAP = 6;

/** Compact handle on a captured request/write the gate re-evaluated. */
export interface ValidationEvent {
  path: string;
  method: string;
  /** uid at capture time; null = unauthenticated. */
  uid: string | null;
}

/**
 * Structured validation block attached to `write_file` results.
 * Keys are present per file type (rules keys on rules writes, `compile`
 * on app writes) and EMPTY on clean writes — the agent treats a write
 * with all-empty arrays as verified-clean and moves on.
 */
export interface WriteValidation {
  /** Rules: lint findings on the deployed (resolved) source. Compact
   *  `severity: [rule] message` strings; parse errors come first. */
  lint?: string[];
  /** Rules: previously-succeeded writes the new rules now DENY. The
   *  strongest repair signal — the edit broke a flow that worked. */
  regressions?: ValidationEvent[];
  /** Rules: previously-denied requests that STAY denied. Informational:
   *  these may be intended denials — repair only the ones the task
   *  meant to unblock. */
  stillDenied?: ValidationEvent[];
  /** Rules: previously-denied requests the new rules now allow. */
  unblocked?: number;
  /** App: compile/syntax errors in the written module. */
  compile?: string[];
  /** Set when the gate itself failed — the write landed WITHOUT
   *  validation (degraded mode, never a blocked write). */
  gateError?: string;
}

/** True when the gate ran and found nothing to repair. */
export function isValidationClean(v: WriteValidation): boolean {
  return (
    v.gateError === undefined &&
    (v.lint?.length ?? 0) === 0 &&
    (v.regressions?.length ?? 0) === 0 &&
    (v.compile?.length ?? 0) === 0
  );
}

/** One-line summary fragment for the tool-result summary string.
 *  `stillDenied` is deliberately excluded (informational, not a defect). */
export function summarizeValidation(v: WriteValidation): string {
  if (v.gateError !== undefined) return `validation skipped (${v.gateError})`;
  const parts: string[] = [];
  if (v.lint && v.lint.length > 0) parts.push(`${v.lint.length} lint`);
  if (v.regressions && v.regressions.length > 0) {
    parts.push(`${v.regressions.length} regression${v.regressions.length === 1 ? '' : 's'}`);
  }
  if (v.compile && v.compile.length > 0) {
    parts.push(`${v.compile.length} compile error${v.compile.length === 1 ? '' : 's'}`);
  }
  if (typeof v.unblocked === 'number' && v.unblocked > 0) {
    parts.push(`${v.unblocked} denial${v.unblocked === 1 ? '' : 's'} unblocked`);
  }
  return parts.length === 0 ? 'validation clean' : `validation: ${parts.join(', ')}`;
}

// ─── Rules gate ───────────────────────────────────────────────────────

function formatLintWarning(w: LintWarning): string {
  const loc = w.location;
  const where = loc?.functionName
    ? `in ${loc.functionName}: `
    : loc?.matchPath
      ? `at ${loc.matchPath}: `
      : '';
  return `${w.severity}: ${where}${w.rule ? `[${w.rule}] ` : ''}${w.message}`;
}

function cap(list: string[]): string[] {
  if (list.length <= CAP) return list;
  return [...list.slice(0, CAP), `(+${list.length - CAP} more)`];
}

function capEvents(list: ValidationEvent[]): ValidationEvent[] {
  return list.length <= CAP ? list : list.slice(0, CAP);
}

/** Dependency seam for tests — the production path reads the runner
 *  singleton's sandbox. */
export interface RulesGateDeps {
  history(): SandboxEvent[];
  snapshot(): unknown;
}

function runnerDeps(): RulesGateDeps {
  const sandbox = getPlaygroundRuntime().requireInProcessRunner('Rules write history validation').getSandbox();
  return {
    history: () => sandbox.history(),
    snapshot: () => getInternalEnv(sandbox).snapshot(),
  };
}

/**
 * Validate a rules write post-deploy: lint the deployed source, then run
 * the two-phase history verifier (regressions via `replay`, fix/still-denied
 * via re-simulation of captured denials). Empty history short-circuits the
 * history phases — lint still runs. Never throws.
 */
export function validateRulesWrite(
  deployedSource: string,
  deps?: RulesGateDeps,
): WriteValidation {
  try {
    const lintResult = lintFirestoreRules(deployedSource);
    const lint: string[] = [];
    if (lintResult.parseError) {
      const pe = lintResult.parseError;
      lint.push(`error: parse error at ${pe.line}:${pe.column} — expected ${pe.expected}`);
    } else {
      for (const w of lintResult.warnings) lint.push(formatLintWarning(w));
    }

    const out: WriteValidation = {
      lint: cap(lint),
      regressions: [],
      stillDenied: [],
      unblocked: 0,
    };

    // Un-parseable rules can't be replayed/simulated — the parse error IS
    // the evidence; running the history phases would only throw.
    if (lintResult.parseError) return out;

    const d = deps ?? runnerDeps();
    const events = d.history();
    if (events.length === 0) return out;

    const { deniedRequests, writes } = partitionEvents(events);

    // Phase 1 — regressions: replay captured writes under the new rules.
    if (writes.length > 0) {
      const result = replay(
        events,
        deployedSource,
        { pinRequestTime: true },
        d.snapshot() as never,
      );
      const { nowDenied } = classifyRegressions(result.divergences, writes);
      out.regressions = capEvents(
        nowDenied.map((r) => ({ path: r.path, method: r.method, uid: r.auth?.uid ?? null })),
      );
    }

    // Phase 2 — re-simulate captured denials: unblocked vs still denied.
    if (deniedRequests.length > 0) {
      const cases: TestCase[] = [];
      const withCase: typeof deniedRequests = [];
      for (const ev of deniedRequests) {
        const tc = requestEventToTestCase(ev);
        if (tc) {
          cases.push(tc);
          withCase.push(ev);
        }
      }
      if (cases.length > 0) {
        const sim = new SimulateFirestoreRulesHandler().simulate(deployedSource, cases);
        if (sim.success) {
          const stillDenied: ValidationEvent[] = [];
          let unblocked = 0;
          for (let i = 0; i < withCase.length; i++) {
            const ev = withCase[i]!;
            const decision = sim.data.results[i]?.decision;
            if (decision === 'ALLOW') unblocked += 1;
            else if (decision === 'DENY') {
              stillDenied.push({ path: ev.path, method: ev.method, uid: ev.auth?.uid ?? null });
            }
            // UNSUPPORTED: simulator abstained — neither bucket.
          }
          out.stillDenied = capEvents(stillDenied);
          out.unblocked = unblocked;
        }
      }
    }

    return out;
  } catch (e) {
    return { gateError: e instanceof Error ? e.message : String(e) };
  }
}

// ─── App (compile) gate ───────────────────────────────────────────────

/** esbuild throws build-failure objects carrying an `errors` array;
 *  anything else is an environment/gate failure. */
function esbuildErrorMessages(e: unknown): string[] | null {
  if (typeof e === 'object' && e !== null && 'errors' in e) {
    const errors = (e as { errors: Array<{ text: string; location?: { line: number; column: number } | null }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((err) =>
        err.location ? `${err.text} (line ${err.location.line})` : err.text,
      );
    }
  }
  return null;
}

/** True for paths the app gate covers. */
export function isAppSourcePath(path: string): boolean {
  return path.endsWith('.tsx') || path.endsWith('.ts');
}

/** Real browser (not the harness's `window` polyfill) — the preview
 *  compile pipeline needs vite's `?url` wasm asset, which only exists
 *  in the browser bundle. */
function isBrowser(): boolean {
  return typeof document !== 'undefined';
}

/** Syntax-level TSX/TS check. Browser: the warm esbuild-wasm service.
 *  Node (harness): direct `esbuild-wasm` (works without `initialize`). */
async function syntaxCheck(content: string): Promise<string[]> {
  let transform: (src: string, opts: object) => Promise<unknown>;
  if (isBrowser()) {
    // Browser path — the preview's warm singleton (vite `?url` wasm import).
    const { getEsbuild } = await import('~/lib/preview/esbuild-service');
    transform = (await getEsbuild()).transform as never;
  } else {
    // Node path — esbuild-wasm runs the wasm directly, no initialize().
    const esbuild = await import('esbuild-wasm');
    transform = esbuild.transform as never;
  }
  try {
    await transform(content, { loader: 'tsx', jsx: 'automatic' });
    return [];
  } catch (e) {
    const msgs = esbuildErrorMessages(e);
    if (msgs) return cap(msgs);
    throw e; // not a compile failure — environment/gate error
  }
}

/**
 * Validate an app-source write. The preview entry gets the full
 * `compileApp` bundle (real import resolution — exactly what the preview
 * will do); other modules get a syntax-level transform. Never throws.
 */
export async function validateAppWrite(
  path: string,
  content: string,
): Promise<WriteValidation> {
  try {
    if (path === APP_ENTRY_PATH && isBrowser()) {
      const { compileApp } = await import('~/lib/preview/compile');
      const res = await compileApp(content);
      return {
        compile: res.ok
          ? []
          : cap([res.line !== undefined ? `${res.message} (line ${res.line})` : res.message]),
      };
    }
    // Non-entry modules everywhere + the entry in the Node harness:
    // syntax-level transform (no bundling / import resolution).
    return { compile: await syntaxCheck(content) };
  } catch (e) {
    return { gateError: e instanceof Error ? e.message : String(e) };
  }
}
