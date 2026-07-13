/**
 * Diagnostic tool manifest. Tools here are registered ONLY when
 * `useSettingsStore.pyricDiagnosticsEnabled` is true (the master
 * switch) AND the per-tool flag in `diagnosticToolsEnabled` is true.
 * The whole layer is designed for qualitative A/B comparison of
 * agent quality with vs. without pyric's diagnostic enhancements.
 *
 * Adding a tool group:
 *   1. Add an entry to `DIAGNOSTIC_TOOL_MANIFEST` with a stable
 *      `key` (used as the settings flag), `label`/`description`
 *      (rendered in the Settings modal), and a `build()` factory
 *      that returns its ToolHandlers.
 *   2. That's it. The Settings modal sub-panel and the registry
 *      filter both pick it up from the manifest.
 *
 * Companion locations:
 *   - `~/lib/agent/diagnostics/` — system-prompt blocks + tool
 *     context fields (`ctx.lint` etc.) gated on the same master.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { isDiagnosticToolEnabled, useSettingsStore } from '~/lib/store/settings';
import { buildDebugFirestoreRulesHandler } from './debug-firestore-rules';
import { buildGenerateFixtureFromSessionHandler } from './generate-fixture-from-session';
import { buildInspectFirestoreTrafficHandler } from './inspect-firestore-traffic';
import { buildSimulateFirestoreWriteHandler } from './simulate-firestore-write';
import { buildTryRulesEditHandler } from './try-rules-edit';

export interface DiagnosticToolEntry {
  /** Stable key persisted in localStorage as the per-tool flag. */
  key: string;
  /** Short title rendered in the Settings modal. */
  label: string;
  /** Body text rendered under the title (one-liner is fine). */
  description: string;
  /** Factory that yields the tool handlers for this diagnostic. */
  build(): ToolHandler[];
}

export const DIAGNOSTIC_TOOL_MANIFEST: readonly DiagnosticToolEntry[] = [
  {
    key: 'simulate_firestore_write',
    label: 'Firestore: simulate rule evaluation',
    description:
      'simulate_firestore_write. Runs SimulateFirestoreRulesHandler in-process against a proposed ruleset + write payload + auth context — no deploy, no network. Returns the decision, raw debug trail, and a one-line summary so the agent can iterate on rules without round-tripping through the App preview.',
    // Sandbox-only — the simulator runs entirely in-process so this
    // tool is available even when no project / access token is set.
    build: () => [buildSimulateFirestoreWriteHandler()],
  },
  {
    key: 'inspect_firestore_traffic',
    label: 'Sandbox: inspect Firestore traffic log',
    description:
      'inspect_firestore_traffic. Structured dump of every Firestore op the in-browser sandbox has evaluated this session (reads, writes, denials, paths, durations) with decision/path/origin filters. Distinct from `inspect_denial` (drill-down into ONE denial) — this is the WHOLE log for spotting cross-session patterns. Sandbox-local, no auth needed.',
    build: () => [buildInspectFirestoreTrafficHandler()],
  },
  {
    key: 'generate_fixture_from_session',
    label: 'Sandbox: generate replay fixture from session',
    description:
      'generate_fixture_from_session. Snapshot the current sandbox session — `history()` + every doc — as a JSON fixture in the format consumed by `examples/replay/ci/check-fixtures.ts`. Use after the user validates a feature works: the captured fixture becomes a permanent CI regression gate. No filesystem write — tool returns serialized JSON for the agent to surface.',
    // Local-only — pulls from the in-process sandbox. No auth required.
    build: () => [buildGenerateFixtureFromSessionHandler()],
  },
  {
    key: 'try_rules_edit',
    label: 'Sandbox: try rules edit (replay + simulate)',
    description:
      'try_rules_edit. Two-phase verifier for a proposed Firestore Rules edit: replays captured writes under the proposed rules to detect REGRESSIONS, and re-simulates previously-denied requests to detect FIXES. Use after drafting a rule change and BEFORE proposing it — confirms the edit unblocks the failing case without breaking other flows. Local sandbox only; reads `sandbox.history()`.',
    // Local-only — operates entirely on the in-process sandbox.
    build: () => [buildTryRulesEditHandler()],
  },
  {
    key: 'debug_firestore_rules',
    label: 'Sandbox: debug Firestore rules (orchestrator)',
    description:
      'debug_firestore_rules. One-call diagnostic that auto-locates the failing event from the traffic ring buffer (or by eventId), re-simulates against the supplied rules with the per-expression trace, pulls sandbox state at the path, runs lint, and synthesizes a `diagnosis` with a heuristic likely-cause + the load-bearing failing expression + human-readable notes. Composes existing primitives (simulate, admin read, lint) into one round-trip.',
    // Local-only — composes other local-only diagnostics.
    build: () => [buildDebugFirestoreRulesHandler()],
  },
];

/**
 * Compute the diagnostic tools available for THIS turn. Re-evaluated
 * every time `buildToolRegistry()` runs (per submit) so per-tool setting
 * changes take effect on the next submit.
 *
 * The gates a manifest entry passes:
 *   1. Master `pyricDiagnosticsEnabled` is on (checked by the caller
 *      in `~/lib/tools/index.ts`; if off, this function isn't called).
 *   2. Per-tool flag is on (`isDiagnosticToolEnabled` — defaults to
 *      true so newly-shipped tools light up without a settings write).
 */
export function getDiagnosticTools(): ToolHandler[] {
  if (typeof window === 'undefined') return [];
  const settings = useSettingsStore.getState();

  const handlers: ToolHandler[] = [];
  for (const entry of DIAGNOSTIC_TOOL_MANIFEST) {
    if (!isDiagnosticToolEnabled(settings, entry.key)) continue;
    handlers.push(...entry.build());
  }
  return handlers;
}
