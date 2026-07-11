/**
 * Pure helpers for `debug_firestore_rules`. The orchestrator handler
 * composes existing primitives (`simulate_firestore_write`,
 * `LocalEnvironment.admin.getDocument`, `lintFirestoreRules`) plus
 * the captured traffic ring buffer; this module holds the analysis
 * logic that turns those raw outputs into a synthesized `diagnosis`.
 *
 * Split out so unit tests can exercise it without the runner
 * singleton or workspace-dep chain pulling in @pyric/firestore etc.
 */
import type {
  ExprTraceEntry,
  PathResolutionEntry,
  RuleEvaluation,
  TestResult,
} from 'pyric/rules/internal';

// ─── Public arg / result shapes ──────────────────────────────────────

export interface DebugFirestoreRulesArgs {
  /** Specific traffic entry to debug. When omitted, the tool falls
   *  back to the latest denial in the ring buffer. */
  eventId?: string;
}

/**
 * One of five heuristic classifications for the load-bearing failure
 * in the rule's condition. Drives the suggested-fix language the
 * agent renders for the user. Not exhaustive — DEFAULT bucket exists
 * specifically so we don't over-claim when the heuristic can't
 * confidently identify a cause.
 */
export type LikelyCause =
  | 'AUTH_MISSING'        // `request.auth` was null and the rule required identity
  | 'IDENTITY_MISMATCH'   // auth was present but the uid/claim check disagreed
  | 'FIELD_MISMATCH'      // `resource.data.<x>` or `request.resource.data.<x>` produced null/wrong value
  | 'PATH_MISMATCH'       // no `match` block covered the path
  | 'UNSUPPORTED_SURFACE' // simulator hit an unmodelled feature
  | 'RULE_REJECTED_VALID'; // fallback — rule evaluated cleanly but the verdict was deny

/**
 * The leafmost `ExprTraceEntry` whose value flipped the rule's
 * decision. For an `&&` chain, this is the conjunct that returned
 * false; for an OR chain that ended in deny, it's the LAST disjunct
 * the simulator evaluated (the others were also false but the last
 * one is the most informative for diagnosis).
 *
 * `cause` is derived from the entry's `source` + `value` + the
 * surrounding event context.
 */
export interface FailingExpression {
  /** Pretty-printed source. From `expressionTrace[i].source`. */
  source: string;
  /** AST kind — useful for filtering in agent prompts. */
  kind: ExprTraceEntry['kind'];
  /** The evaluated value (typically `false`, sometimes `null`). */
  value?: unknown;
  /** Index into the rule's expressionTrace. Lets the agent navigate
   *  the parent chain back to the rule root if needed. */
  traceIndex: number;
  /** 1-indexed source line of the enclosing `allow` rule. From the
   *  `RuleEvaluation.line` we drilled into; null when unavailable
   *  (programmatically-constructed rules without `loc`). */
  line?: number;
}

export interface DebugFirestoreRulesDiagnosis {
  likelyCause: LikelyCause;
  /** The load-bearing failure in the rule. Absent when no
   *  `expressionTrace` was produced (no allow rule was evaluated at
   *  all — see PATH_MISMATCH path). */
  failingExpression?: FailingExpression;
  /** What `resource.data` actually is at the path, via admin-bypass
   *  read. Lets the agent confirm "the rule reads owner=X but the
   *  doc actually has owner=Y" without an extra round-trip. `null`
   *  when the doc doesn't exist; absent when admin read failed. */
  sandboxStateAtPath?: Record<string, unknown> | null;
  /** Lint findings for the current rules source — surfaced so the
   *  agent can see "your rule has a known pitfall pattern" alongside
   *  the specific failure. `ruleIndex` / `matchPath` / `functionName`
   *  scope each finding to a structural element (the linter doesn't
   *  expose source line/column today). May be empty. */
  lintFindings: Array<{
    message: string;
    severity: 'warning' | 'error';
    ruleIndex?: number;
    matchPath?: string;
    functionName?: string;
  }>;
  /** "Near-miss" match blocks the resolver considered when the
   *  request path landed in default-deny. Sorted by how many path
   *  segments matched (descending) so the closest fit is first. Only
   *  populated when `likelyCause === 'PATH_MISMATCH'` — empty for
   *  every other diagnosis bucket. Top 3 entries max to keep the
   *  agent's prompt scannable. */
  pathNearMisses: PathResolutionEntry[];
  /** Human-readable summary lines the agent can quote to the user.
   *  Each line is independently meaningful — the agent picks the
   *  most relevant for a given context. */
  notes: string[];
}

// ─── Heuristic — find the failing leaf ───────────────────────────────

/**
 * Locate the load-bearing failing expression in a single
 * `RuleEvaluation`. The leaf-most entry that returned `false`,
 * `null`, or undefined (in the boolean sense) and isn't `skipped`
 * or `error` — that's the operand the agent should attribute the
 * denial to.
 *
 * Algorithm: pre-order walk; at each entry, if it has children that
 * are themselves "failing" (recursive), descend; otherwise return
 * this entry. For an `&&` chain `a && b && c` where `b` is false,
 * the trace evaluates `a` (true), `b` (false), skips `c`. The
 * failing leaf is `b`'s root entry plus any of `b`'s own children
 * that are themselves false. This matches the agent's intuition of
 * "the first conjunct that broke the rule."
 *
 * Returns null when the trace has no failing entries — typically
 * means the rule evaluated cleanly to `true` (or the entry was
 * `ALLOW` and the caller passed the wrong evaluation).
 */
export function findFailingLeaf(
  trace: readonly ExprTraceEntry[],
): { entry: ExprTraceEntry; index: number } | null {
  if (trace.length === 0) return null;

  const isFailing = (entry: ExprTraceEntry): boolean => {
    if (entry.skipped) return false;
    // `error` entries are explicit failures, but the failing leaf
    // is usually the THING that caused the error, not the error
    // wrapper itself. Still, if no deeper failing-falsy leaf
    // exists, the error entry IS the answer.
    if (entry.error !== undefined) return true;
    if (entry.value === false) return true;
    if (entry.value === null) return true;
    if (entry.value === undefined) return true; // some method calls return undefined for misses
    return false;
  };

  // Strategy: pick the failing entry with the HIGHEST INDEX in the
  // trace. The evaluator pushes entries in evaluation order — for an
  // `a && b && c` chain that fails at `b`, the trace ends at `b`
  // (c is skipped). For an `a || b || c` chain where all fail, the
  // trace runs all the way to `c`. In both cases, highest-index is
  // the most-recently-evaluated failing leaf — that's the one the
  // agent should attribute the denial to. Earlier we used DFS+depth
  // ranking, but depth conflated AND vs OR semantics; flat
  // last-evaluated wins for both.
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i];
    if (entry && isFailing(entry)) {
      return { entry, index: i };
    }
  }
  return null;
}

// ─── Heuristic — classify cause ──────────────────────────────────────

/**
 * Classify the failing expression into one of five buckets based on
 * its source text + value + the surrounding request event's auth
 * shape. Heuristic, not exact — the goal is to surface a useful
 * fix-target prompt, not to be a complete static analyzer.
 *
 * Order of checks matters: more specific patterns first, falling
 * through to RULE_REJECTED_VALID as the "I can't characterize this"
 * bucket. The agent reads `likelyCause` + `notes` together; the
 * notes carry the qualitative detail that the enum can't.
 */
export function classifyCause(opts: {
  failing: FailingExpression | undefined;
  /** Verdict for the rule that produced this failing expression.
   *  When ERROR/UNSUPPORTED, classification short-circuits. */
  verdict?: RuleEvaluation['verdict'];
  /** Whether the simulated request carried auth. Lets us
   *  disambiguate AUTH_MISSING from IDENTITY_MISMATCH. */
  hasAuth: boolean;
  /** Whether the simulator ever matched a rule for this request.
   *  When false, PATH_MISMATCH is the more useful classification
   *  than any failingExpression-based bucket. */
  matchedAnyRule: boolean;
}): LikelyCause {
  if (!opts.matchedAnyRule) return 'PATH_MISMATCH';
  if (opts.verdict === 'UNSUPPORTED') return 'UNSUPPORTED_SURFACE';

  const f = opts.failing;
  if (!f) return 'RULE_REJECTED_VALID';

  const src = f.source;
  // Auth checks — exact patterns the grammar commonly produces.
  // `request.auth != null` evaluating false → AUTH_MISSING.
  if (/request\.auth\s*!=\s*null/.test(src) && f.value === false) {
    return 'AUTH_MISSING';
  }
  // `request.auth.uid == X` / `request.auth.uid != X` /
  // `request.auth.uid in collection` evaluating false → IDENTITY_MISMATCH.
  // Tighter than "source contains request.auth.uid" — we require an
  // equality/membership operator at the comparison level, so that
  // `isAdmin(request.auth.uid)` (uid passed as a function arg) doesn't
  // get misclassified when the actual failure is inside the function.
  if (
    /request\.auth\.uid\s*(==|!=|\bin\b)/.test(src) &&
    f.value === false &&
    opts.hasAuth
  ) {
    return 'IDENTITY_MISMATCH';
  }
  // resource.data.<x> resolving to null/undefined → FIELD_MISMATCH.
  // We catch the value here too because the trace records the
  // memberAccess's evaluated result.
  if (/^(request\.)?resource\.data\./.test(src) && (f.value === null || f.value === undefined)) {
    return 'FIELD_MISMATCH';
  }
  // Comparison against a resource.data field that evaluated false
  // is usually a field-shape mismatch (rule expected one value, doc
  // has another).
  if (/(request\.)?resource\.data\./.test(src) && f.value === false) {
    return 'FIELD_MISMATCH';
  }
  return 'RULE_REJECTED_VALID';
}

// ─── Notes builder ───────────────────────────────────────────────────

/**
 * Build the `notes` array for `DebugFirestoreRulesDiagnosis`. Each
 * note is a one-line, human-readable statement of one aspect of the
 * failure — the agent picks which to surface to the user. Ordering
 * is consistent so the agent can rely on note[0] being the headline.
 */
export function buildDiagnosisNotes(opts: {
  likelyCause: LikelyCause;
  failing?: FailingExpression;
  sandboxStateAtPath?: Record<string, unknown> | null;
  rulePath?: string;
  methodOp?: string;
  /** Near-miss `match` blocks for PATH_MISMATCH cases. Surfaced in
   *  the notes when the cause is PATH_MISMATCH and the list is
   *  non-empty — gives the agent a concrete "did you mean this
   *  block?" prompt instead of a generic "no match found." */
  pathNearMisses?: readonly PathResolutionEntry[];
}): string[] {
  const out: string[] = [];

  switch (opts.likelyCause) {
    case 'AUTH_MISSING':
      out.push(
        'Headline: the rule requires `request.auth != null` but the request arrived unauthenticated. The caller must be signed in before this op fires.',
      );
      break;
    case 'IDENTITY_MISMATCH':
      out.push(
        `Headline: the rule's identity check ${opts.failing ? `(\`${opts.failing.source}\`) ` : ''}evaluated false — the signed-in user is not the identity the rule expects. Either the wrong user is calling, or the rule needs to allow this identity.`,
      );
      break;
    case 'FIELD_MISMATCH':
      out.push(
        `Headline: the rule references ${opts.failing ? `\`${opts.failing.source}\` ` : 'a data field '}and got an unexpected value. Inspect the request payload (\`request.resource.data\`) vs. what the rule expects.`,
      );
      break;
    case 'PATH_MISMATCH':
      out.push(
        `Headline: no \`match\` block in the rules covered ${opts.rulePath ? `\`${opts.rulePath}\`` : 'this path'}. Either the path is wrong, or the ruleset needs a new \`match\` rule for it.`,
      );
      break;
    case 'UNSUPPORTED_SURFACE':
      out.push(
        'Headline: the local simulator hit a feature it doesn\'t implement yet. The denial may not reflect the real Firebase rules engine — fall back to running against the App preview (`runOnce`) to confirm.',
      );
      break;
    case 'RULE_REJECTED_VALID':
      out.push(
        `Headline: the rule${opts.failing ? `'s \`${opts.failing.source}\`` : ''} evaluated cleanly and produced a deny. Inspect the failing expression's value vs. the rule's intent.`,
      );
      break;
  }

  if (opts.failing?.line !== undefined) {
    out.push(`Failing rule line: ${opts.failing.line}.`);
  }

  if (opts.sandboxStateAtPath === null) {
    out.push('Sandbox state at path: document does NOT exist. Rules that read `resource.data` will see an absent doc.');
  } else if (opts.sandboxStateAtPath !== undefined) {
    const keys = Object.keys(opts.sandboxStateAtPath);
    out.push(
      `Sandbox state at path: doc exists with ${keys.length} field${keys.length === 1 ? '' : 's'}: ${keys.length === 0 ? '(empty)' : keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''}.`,
    );
  }

  if (
    opts.likelyCause === 'PATH_MISMATCH' &&
    opts.pathNearMisses &&
    opts.pathNearMisses.length > 0
  ) {
    // Render top near-misses as "<blockPath> at line N (matched M of T
    // segments — <reason>)". Already sorted closest-first by the
    // selector; we just format. Cap at 3 to keep the agent's prompt
    // scannable; more than 3 noise more than they help.
    const top = opts.pathNearMisses.slice(0, 3);
    const lines = top.map(nm => {
      const at = nm.line !== undefined ? ` at line ${nm.line}` : '';
      const reason = nm.reason ? ` — ${nm.reason}` : '';
      return `  - \`${nm.blockPath}\`${at} (matched ${nm.matchedSegments}/${nm.totalSegments} segments${reason})`;
    });
    out.push(`Near-miss match blocks (closest first):\n${lines.join('\n')}`);
  }

  return out;
}

/**
 * Pick the most-informative near-miss match blocks from a path
 * resolution trace. Filters out blocks that didn't share at least one
 * segment with the request (totally unrelated paths are noise), then
 * sorts by `matchedSegments` descending so the closest fit is first.
 *
 * Returns the top entries verbatim from the trace — caller decides
 * how many to surface. For the orchestrator's notes builder, 3 is
 * the right cap (see comment in `buildDiagnosisNotes`).
 */
export function selectPathNearMisses(
  attempts: readonly PathResolutionEntry[],
): PathResolutionEntry[] {
  return attempts
    .filter(a => !a.matched && a.matchedSegments > 0)
    .slice() // copy before sorting — defensive against caller-owned arrays
    .sort((a, b) => b.matchedSegments - a.matchedSegments);
}

// ─── Failing-expression extractor ────────────────────────────────────

/**
 * Pick the determining `RuleEvaluation` from a simulator result's
 * per-rule trace AND extract the leafmost failing expression from
 * its `expressionTrace`. Returns null when no rule was evaluated
 * (the PATH_MISMATCH path).
 *
 * The "determining" rule for a DENY: the last rule the simulator
 * looked at — under OR semantics it had to evaluate every disjunct,
 * so the last one is the most-informative as the agent's anchor.
 * For UNSUPPORTED, it's the rule with verdict UNSUPPORTED.
 */
export function extractFailingExpression(
  trace: readonly RuleEvaluation[],
): FailingExpression | null {
  if (trace.length === 0) return null;
  // Match what try_rules_edit uses for "determining": prefer UNSUPPORTED
  // for unsupported, last entry otherwise.
  let determining: RuleEvaluation | undefined;
  const unsupported = trace.find(e => e.verdict === 'UNSUPPORTED');
  if (unsupported) {
    determining = unsupported;
  } else {
    determining = trace[trace.length - 1];
  }
  if (!determining || !determining.expressionTrace) return null;
  const leaf = findFailingLeaf(determining.expressionTrace);
  if (!leaf) return null;
  const result: FailingExpression = {
    source: leaf.entry.source,
    kind: leaf.entry.kind,
    traceIndex: leaf.index,
  };
  if (leaf.entry.value !== undefined) result.value = leaf.entry.value;
  if (determining.line !== undefined) result.line = determining.line;
  return result;
}

// ─── Diagnosis builder ───────────────────────────────────────────────

/**
 * Minimal event-context shape `buildDiagnosis` needs. Defined locally
 * (rather than importing `RequestEvent` from `@pyric/sandbox`) so the
 * shared module stays focused on analysis logic and pulls zero
 * sandbox-side types. Handlers map their captured event → this shape
 * at the call site.
 */
export interface DiagnosisEventContext {
  /** The Firestore op the original request was performing. */
  method: string;
  /** Request path the original event targeted. */
  path: string;
  /** Auth identity at the time of the original request, or null
   *  when the request was anonymous. */
  auth: { uid: string; token?: Record<string, unknown> } | null;
}

export interface BuildDiagnosisInput {
  /** The simulator result for the re-simulated case. */
  tr: TestResult;
  /** Context about the original request being debugged. */
  event: DiagnosisEventContext;
  /** Admin-bypass dump of `resource.data` at the failing path, or
   *  null when the doc doesn't exist. `undefined` (vs. `null`) means
   *  the read was never attempted — note rendering distinguishes
   *  "absent doc" from "didn't try." */
  sandboxStateAtPath?: Record<string, unknown> | null;
  /** Lint findings the handler harvested. Passed through verbatim
   *  into `diagnosis.lintFindings`. */
  lintFindings: DebugFirestoreRulesDiagnosis['lintFindings'];
}

/**
 * Synthesize a `DebugFirestoreRulesDiagnosis` from the simulator
 * result + the original event + the orchestrator's harvested context
 * (sandbox state read + lint findings). Pure — no I/O, no singletons.
 *
 * This is the analysis layer the handler delegates to. Keeping it
 * pure means unit tests can assert end-to-end "given a TestResult
 * that looks like X, the diagnosis comes out like Y" without spinning
 * up a sandbox or stubbing the runner.
 *
 * Glues four pure helpers in sequence:
 *   1. `extractFailingExpression` → load-bearing leaf
 *   2. `classifyCause` → likely-cause enum
 *   3. `selectPathNearMisses` → top near-misses (PATH_MISMATCH only)
 *   4. `buildDiagnosisNotes` → human-readable summary lines
 */
export function buildDiagnosis(input: BuildDiagnosisInput): DebugFirestoreRulesDiagnosis {
  const { tr, event, sandboxStateAtPath, lintFindings } = input;
  const failing = extractFailingExpression(tr.trace) ?? undefined;
  // Pick the determining rule the same way `extractFailingExpression`
  // does — UNSUPPORTED first, else last entry. Need it separately
  // because we want its verdict for the cause classifier and we
  // don't want extractFailingExpression to return it (the function's
  // contract is just the leaf).
  const unsupported = tr.trace.find(e => e.verdict === 'UNSUPPORTED');
  const determining = unsupported ?? tr.trace[tr.trace.length - 1];
  const likelyCause: LikelyCause = classifyCause({
    failing,
    verdict: determining?.verdict,
    hasAuth: event.auth !== null,
    matchedAnyRule: tr.trace.length > 0,
  });

  // PATH_MISMATCH-only — gated here (not in the selector) so a stray
  // call site that forgets to filter doesn't leak match-block detail
  // into other diagnoses. See the corresponding defensive test.
  const pathNearMisses =
    likelyCause === 'PATH_MISMATCH' && tr.pathResolution
      ? selectPathNearMisses(tr.pathResolution.attempts)
      : [];

  const notes = buildDiagnosisNotes({
    likelyCause,
    failing,
    sandboxStateAtPath,
    rulePath: event.path,
    methodOp: event.method,
    pathNearMisses,
  });

  const diagnosis: DebugFirestoreRulesDiagnosis = {
    likelyCause,
    lintFindings,
    pathNearMisses,
    notes,
  };
  if (failing) diagnosis.failingExpression = failing;
  if (sandboxStateAtPath !== undefined) diagnosis.sandboxStateAtPath = sandboxStateAtPath;
  return diagnosis;
}
