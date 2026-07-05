import type {
  RuleEvaluation,
  PathResolutionTrace,
  PathResolutionEntry,
  ExprTraceEntry,
  FirestoreMethod,
} from 'pyric/rules';

// Re-export the simulator trace types so consumers of `@pyric/ui/rules`
// can describe a `Denial` without reaching into `pyric/rules` themselves.
export type {
  RuleEvaluation,
  PathResolutionTrace,
  PathResolutionEntry,
  ExprTraceEntry,
  FirestoreMethod,
};

/**
 * The lens a request was issued under, mirroring the Studio's identity
 * model:
 *   - `'admin'`        — the admin handle (bypasses rules in production,
 *                        shown here for provenance only)
 *   - `{ as: uid }`    — acting as a specific signed-in user
 *   - `'app-session'`  — the ambient app session (whoever is signed in
 *                        in the running preview)
 */
export type DenialLens = 'admin' | { as: string } | 'app-session';

/**
 * One denied Firestore request, enriched with the simulator trace.
 *
 * The live denial *event* carries only `debugMessages`; the rich trace
 * (`evaluation` / `pathResolution`) is produced by re-running the
 * simulator (tracing always on) against the captured request. Build one
 * with `useDenialTrace(request, rulesSource)` then spread the captured
 * request fields alongside.
 */
export interface Denial {
  // ── the captured request ──────────────────────────────────────────
  method: FirestoreMethod;
  /** Resource path, e.g. `notes/3agHoZHZ`. */
  path: string;
  /** `request.auth` — `null` for an unauthenticated request. */
  auth: { uid: string; token: Record<string, unknown> } | null;
  /** Identity lens the request was issued under. */
  lens?: DenialLens;
  /** `request.resource.data` — present for writes. */
  requestData?: Record<string, unknown>;
  /** `resource.data` — the existing document, `null` when absent. */
  resourceData?: Record<string, unknown> | null;
  /** Capture time (epoch ms). */
  at: number;

  // ── the simulation result ─────────────────────────────────────────
  /** `firestore.rules` source the request was evaluated against. */
  rulesSource: string;
  decision: 'DENY';
  /**
   * Per allow-rule evaluation, in source order. Each entry carries the
   * `line`, `verdict`, `conditionText`, and `expressionTrace`.
   */
  evaluation: RuleEvaluation[];
  /**
   * Path-resolution attempts — present for no-match (default-deny)
   * denials, where no `allow` rule was evaluated because no `match`
   * block covered the path.
   */
  pathResolution?: PathResolutionTrace;
}

/**
 * Per-line verdict for the rule-source view. `deny` is the deciding
 * allow line; `skip` is an allow line whose operations don't include
 * the request method ("not checked"); `allow` is any other allow line.
 * Non-allow lines (match/braces/comments) get no verdict.
 */
export type LineVerdict = 'deny' | 'allow' | 'skip';

export interface DenialInspectorProps {
  denial: Denial;
  /** Sibling denials produced by the same rule. */
  cluster?: Denial[];
  /** Re-run the request under `{ mode: 'as', uid }`. */
  onRerunAs?(uid: string): void;
  /** Re-run against an edited ruleset (a branch). */
  onTestEditedRule?(): void;
  /** A cluster sibling was selected. */
  onSelectCluster?(d: Denial): void;
  className?: string;
}
