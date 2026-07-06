/**
 * `inspect_firestore_traffic` — structured dump of every Firestore op
 * the in-browser sandbox has evaluated this session.
 *
 * Distinct from `inspect_denial` (which drills into ONE specific
 * denial, optionally correlated against the deployed-rules cache):
 * this tool returns the WHOLE traffic log with filters so the agent
 * can spot patterns across the session — repeated denials at the same
 * path, listener cascades, batches that flip allow → deny mid-flight.
 *
 * Source of truth: `useRuntimeStore.getState().traffic` — a 5000-entry
 * ring buffer of `TrafficEntry` (extends `@pyric/sandbox`'s
 * `RequestEvent`). Filters apply in-memory over the snapshot; the
 * agent's `limit` is capped at 500 to keep the result inside a single
 * tool round-trip even on a chatty session.
 *
 * Registration gate: built unconditionally — no auth, no project
 * needed. Traffic is sandbox-local. The master `pyricDiagnosticsEnabled`
 * + per-tool `diagnosticToolsEnabled` flags still gate it via the
 * manifest in `~/lib/tools/diagnostics/index.ts`.
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  runtimeConformance,
  summarizeConformanceLine,
  SPEC_PATH,
  type ConformanceSummary,
} from '~/lib/conformance/conformance-check';
import { useRuntimeStore, type TrafficEntry } from '~/lib/store/runtime';
import { getVFS } from '~/lib/vfs';

/** Hard ceiling on entries returned in one call. Higher requests are
 *  clamped — the result still flows through the LLM context window so
 *  unbounded dumps are not OK even when the ring buffer holds more. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface InspectFirestoreTrafficArgs {
  /** Keep only entries with this rule-engine outcome. */
  decision?: 'allow' | 'deny' | 'unsupported';
  /** Keep only entries whose `path` starts with this prefix. */
  pathPrefix?: string;
  /** Keep only entries with this origin. */
  origin?: 'user' | 'listener' | 'batch' | 'transaction';
  /** Cap on the number of entries returned. Default 100, max 500. */
  limit?: number;
}

export interface InspectFirestoreTrafficEntry {
  id: string;
  at: number;
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  origin: 'user' | 'listener' | 'batch' | 'transaction';
  result: 'allow' | 'deny' | 'unsupported';
  evalMs: number;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  reasons: string[];
  matchedRule?: { ruleIndex: number; operations: string[] };
  groupId?: string;
  triggeredBy?: { method: string; path: string };
  request?: { resourceData?: Record<string, unknown> };
  resourceBefore?: { data: Record<string, unknown> | null; exists: boolean };
  resourceAfter?: { data: Record<string, unknown> | null; exists: boolean };
}

export interface InspectFirestoreTrafficResult {
  entries: InspectFirestoreTrafficEntry[];
  /** Unfiltered size of the ring buffer at the time of the call. */
  totalCount: number;
  /** Size after filters but BEFORE the limit clamp. */
  filteredCount: number;
  /**
   * Ambient traffic-conformance overlay (SF-S4, report-don't-block).
   * Present only when an AppSpec exists at `/workspace/app.spec.json` AND
   * the (FILTERED) traffic this call returned is non-empty — i.e. the app
   * has actually run in the sandbox, so there is recorded behavior to
   * check. The check diffs each recorded op against the access matrix and
   * flags any the matrix would DENY for the acting identity (an off-
   * contract affordance). It NEVER blocks and NEVER fabricates traffic:
   * it reads what the app already did. Omitted (no field) when there is no
   * signal — no spec, or no matching traffic. This is the natural seam for
   * conformance because traffic only exists AFTER the preview exercises
   * the app; the write itself is too early.
   */
  conformance?: ConformanceSummary;
}

export function buildInspectFirestoreTrafficHandler(): ToolHandler {
  return {
    name: 'inspect_firestore_traffic',
    parallelSafe: true, // read-only (0.2.0 parallelDispatch)
    description:
      'Return a structured dump of Firestore ops the in-browser sandbox has evaluated this session — reads, writes, denials, paths, auth, durations. Distinct from `inspect_denial` (which drills into ONE denial): this is the WHOLE traffic log with filters, useful for spotting patterns (repeated denials at the same path, listener cascades, batch ordering). Filter by `decision` (allow/deny/unsupported), `pathPrefix`, and `origin` (user/listener/batch/transaction). `limit` defaults to 100 and is capped at 500 — most-recent entries are returned first. When an app spec exists at /workspace/app.spec.json, the result also carries a `conformance` overlay: any recorded op the access matrix would DENY for the acting identity (an off-contract affordance the UI exposed) — report-only, surfaced after the app has run so you can spot behavioral contract violations the rules check alone misses.',
    parameters: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['allow', 'deny', 'unsupported'],
          description:
            'Keep only entries with this rule-engine outcome. Omit to include all outcomes.',
        },
        pathPrefix: {
          type: 'string',
          description:
            'Keep only entries whose document path starts with this prefix (e.g. "users/" or "todos/abc"). Omit to include all paths.',
        },
        origin: {
          type: 'string',
          enum: ['user', 'listener', 'batch', 'transaction'],
          description:
            'Keep only entries with this origin. `user` = direct app call; `listener` = snapshot listener re-eval; `batch`/`transaction` = grouped commit. Omit to include all origins.',
        },
        limit: {
          type: 'number',
          description: `Cap on entries returned. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}. Most-recent entries are returned first (newest-last after the limit clamp).`,
        },
      },
    },
    async execute(args) {
      const a = (args ?? {}) as InspectFirestoreTrafficArgs;
      const traffic = useRuntimeStore.getState().traffic;
      const totalCount = traffic.length;

      const filtered: TrafficEntry[] = [];
      for (const entry of traffic) {
        if (a.decision !== undefined && entry.result !== a.decision) continue;
        if (a.origin !== undefined && entry.origin !== a.origin) continue;
        if (a.pathPrefix !== undefined && !entry.path.startsWith(a.pathPrefix)) continue;
        filtered.push(entry);
      }
      const filteredCount = filtered.length;

      // Clamp the agent-supplied limit. Negative or zero → default;
      // anything above MAX_LIMIT → MAX_LIMIT. This keeps the result
      // bounded regardless of what the agent asked for.
      let limit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? a.limit : DEFAULT_LIMIT;
      if (limit <= 0) limit = DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      // Ring buffer is newest-LAST. Take the tail to get most-recent
      // entries; preserve chronological order in the output (oldest
      // first within the window) so the agent can scan top-to-bottom
      // and see causality (a write followed by listener re-evals).
      const windowed =
        filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
      const entries = windowed.map(projectEntry);

      // ── Ambient conformance (SF-S4, report-don't-block) ──────────────
      // Diff the FILTERED traffic (the slice the agent is actually
      // inspecting) against the access matrix. `TrafficEntry` is
      // structurally a `RecordedOp`, so no mapper is needed. Best-effort:
      // a missing/unparseable spec, or empty traffic, yields no overlay.
      // Never throws — a check failure must not break the traffic dump.
      let conformance: ConformanceSummary | undefined;
      try {
        const summary = await runtimeConformance({
          readFile: (path) =>
            getVFS()
              .promises.readFile(path, 'utf8')
              .then((v) => (typeof v === 'string' ? v : new TextDecoder().decode(v)))
              .catch(() => null),
          traffic: filtered,
          specPath: SPEC_PATH,
        });
        if (summary) conformance = summary;
      } catch {
        // conformance is a best-effort overlay — swallow and omit it.
      }

      const summary = describe({
        totalCount,
        filteredCount,
        returned: entries.length,
        args: a,
        conformance,
      });
      return {
        ok: true,
        summary,
        data: {
          entries,
          totalCount,
          filteredCount,
          ...(conformance ? { conformance } : {}),
        } as InspectFirestoreTrafficResult,
      };
    },
  };
}

/**
 * Project a `TrafficEntry` (which extends `RequestEvent` plus the
 * playground's `truncated` overlay) down to the result shape. We
 * pass through the rule-engine-relevant fields verbatim and drop the
 * playground overlay (`truncated`) plus the `kind`/`groupKind`
 * discriminators that exist for typescript narrowing rather than agent
 * reasoning.
 */
function projectEntry(t: TrafficEntry): InspectFirestoreTrafficEntry {
  const out: InspectFirestoreTrafficEntry = {
    id: t.id,
    at: t.at,
    method: t.method,
    path: t.path,
    origin: t.origin,
    result: t.result,
    evalMs: t.evalMs,
    auth: t.auth,
    reasons: t.reasons,
  };
  if (t.matchedRule !== undefined) out.matchedRule = t.matchedRule;
  if (t.groupId !== undefined) out.groupId = t.groupId;
  if (t.triggeredBy !== undefined) out.triggeredBy = t.triggeredBy;
  if (t.request !== undefined) out.request = t.request;
  if (t.resourceBefore !== undefined) out.resourceBefore = t.resourceBefore;
  if (t.resourceAfter !== undefined) out.resourceAfter = t.resourceAfter;
  return out;
}

function describe(args: {
  totalCount: number;
  filteredCount: number;
  returned: number;
  args: InspectFirestoreTrafficArgs;
  conformance?: ConformanceSummary;
}): string {
  if (args.totalCount === 0) {
    return 'inspect_firestore_traffic · no traffic captured this session yet';
  }
  const filters: string[] = [];
  if (args.args.decision) filters.push(`decision=${args.args.decision}`);
  if (args.args.origin) filters.push(`origin=${args.args.origin}`);
  if (args.args.pathPrefix) filters.push(`pathPrefix="${args.args.pathPrefix}"`);
  const filterSuffix = filters.length > 0 ? ` · ${filters.join(', ')}` : '';
  const conformanceSuffix = args.conformance
    ? ` · ${summarizeConformanceLine(args.conformance)}`
    : '';
  return `inspect_firestore_traffic · ${args.returned}/${args.filteredCount} of ${args.totalCount} entries${filterSuffix}${conformanceSuffix}`;
}
