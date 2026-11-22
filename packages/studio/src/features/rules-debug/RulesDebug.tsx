/**
 * Rules-failure debugging UI (Pyric Studio F4).
 *
 * Pure-props, like the `@pyric/ui` surfaces: it takes the list of {@link Denial}s
 * (projected from the event stream by `model.ts`) plus optional re-run callbacks,
 * and renders:
 *   - a LIST of denied ops (left), severity-ramped via `--color-severity-*`,
 *     tagged by service;
 *   - a DETAIL for the selected denial (right): a per-service explanation
 *     (`explainDenial`) — Firestore's matched rule + trace, RTDB's `.write`/
 *     `.validate` node + bindings, Storage's match block + reasons — plus the
 *     `request.auth` context, the resource path/op, and the proposed write;
 *   - two RE-RUN actions: "as the attempting user" (impersonation) and "against
 *     an edited ruleset" (a fork + lint + diff). Each control is graded by
 *     `rerunSupport(denial)`: `live` (enabled when the host wires a callback),
 *     `pending`, or `absent` (disabled with a hint naming the missing mechanical
 *     tool — see `SPEC.md`).
 *
 * Styling is token-only (`--color-danger`, the severity ramp, `--diff-*`, the
 * violet `--color-primary` accent — no green outside the diff-add token) via
 * Tailwind v4 role classes, so it re-themes with the rest of the shell.
 *
 * The re-run callbacks are OPTIONAL: when the host hasn't wired the live worker
 * yet (T3 / Studio pane today), the buttons render disabled with a hint; the
 * denial→rule→context view is fully live regardless.
 */

import { useState, type ReactNode } from 'react';
import { Badge } from '@pyric/ui/primitives';
import { truncateVectorsForDisplay } from '@pyric/ui/firestore';
import {
  explainDenial,
  firestoreRulesetLabel,
  queryProofFailure,
  denialSeverity,
  projectTraceSteps,
  ruleVariables,
  type Denial,
  type DenialSeverity,
  type TraceStep,
  type RuleVariable,
} from './model.js';
import { isQueryProofUnsupported } from './query-proof.js';
import {
  resolveMarkedLine,
  RulesField,
  ServiceRuleDetail,
} from './RulesDebugServiceDetails.js';

export { resolveMarkedLine };

const SEVERITY_DOT: Record<DenialSeverity, string> = {
  low: 'bg-severity-low',
  medium: 'bg-severity-medium',
  high: 'bg-severity-high',
};

export interface RulesDebugProps {
  /** Denied ops, newest first (from `selectDenials(events)`). */
  denials: readonly Denial[];
  /** The DEPLOYED ruleset source, for the read-only "what happened" view (shown
   *  with the denying line marked). */
  rulesSource?: string;
  /** Shown when there are no denials yet (backend-aware copy from the pane). */
  emptyState?: ReactNode;
}

export function RulesDebug({
  denials,
  rulesSource,
  emptyState,
}: RulesDebugProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    denials[0]?.id ?? null,
  );
  const selected =
    denials.find((d) => d.id === selectedId) ?? denials[0] ?? null;

  if (denials.length === 0) {
    return <div data-pyric-ui="rules-debug-empty">{emptyState}</div>;
  }

  return (
    <div
      data-pyric-ui="rules-debug"
      className="grid h-full grid-cols-[18rem_minmax(0,1fr)] gap-4"
    >
      <DenialList
        denials={denials}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
      />
      {selected ? (
        <DenialDetail
          denial={selected}
          rulesSource={rulesSource}
        />
      ) : null}
    </div>
  );
}

// ─── Denial list (left column) ─────────────────────────────────────────────

function DenialList({
  denials,
  selectedId,
  onSelect,
}: {
  denials: readonly Denial[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul
      data-pyric-ui="denial-list"
      className="flex flex-col gap-1 overflow-auto rounded-lg border border-border bg-sidebar-bg p-2"
    >
      {denials.map((d) => {
        const sev = denialSeverity(d);
        const active = d.id === selectedId;
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              aria-current={active ? 'true' : undefined}
              className={`flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                active
                  ? 'bg-danger/10 text-soft-white'
                  : 'text-slate-gray hover:bg-content-bg hover:text-soft-white'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[sev]}`}
                />
                <span className="font-mono text-xs uppercase">{d.method}</span>
                {d.service !== 'firestore' ? (
                  <span className="text-[0.6rem] uppercase tracking-wide text-slate-gray">
                    {d.service}
                  </span>
                ) : null}
                {d.database ? (
                  <span
                    data-denial-database={d.database}
                    className="rounded border border-border px-1 font-mono text-[0.6rem] text-slate-gray"
                  >
                    {d.database}
                  </span>
                ) : null}
                {d.origin === 'listener' ? (
                  <span className="text-[0.6rem] uppercase tracking-wide text-slate-gray">
                    watch
                  </span>
                ) : null}
              </span>
              <span className="truncate font-mono text-xs text-slate-gray">
                {d.path}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Denial detail (right column) ──────────────────────────────────────────

/**
 * The single-op rules-inspection detail: per-service rule explanation,
 * request.auth, the data the rule saw, and the two capability-gated re-runs.
 * Exported pure-props so other surfaces can mount ONE denial's inspection
 * without the list layout — the Traffic surface renders this as a deny row's
 * expanded detail (`features/traffic/TrafficDenialInspector.tsx`).
 */
export function DenialDetail({
  denial,
  rulesSource,
  advisory = false,
}: {
  denial: Denial;
  rulesSource?: string;
  /** The local rules' answer on a call production decided: worded as what the local rules would do, not what happened. */
  advisory?: boolean;
}) {
  const exp = explainDenial(denial);
  let allowLabel = 'allowed';
  let rejectionLabel = 'denied';
  let rejectionKind = 'deny';
  if (isQueryProofUnsupported(denial)) {
    rejectionLabel = 'Query proof unsupported';
    rejectionKind = 'proof-unsupported';
  } else if (denial.unsupported) {
    rejectionLabel = 'unsupported';
    rejectionKind = 'unsupported';
  } else if (advisory) {
    rejectionLabel = 'local rules would deny';
  }
  let advisoryLead: string | undefined;
  if (advisory && !denial.unsupported) {
    const verb = denial.result === 'allow' ? 'allow' : 'deny';
    if (denial.result === 'allow') allowLabel = 'local rules would allow';
    advisoryLead = `Local rules would ${verb} ${denial.method} on ${denial.path}; production's answer above is what happened.`;
  }
  return (
    <div
      data-pyric-ui="denial-detail"
      className="flex min-h-0 flex-col gap-4 overflow-auto rounded-lg border border-border bg-sidebar-bg p-5"
    >
      {/* The verdict headline + the rule that decided it. */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          {denial.result === 'allow' ? (
            <Badge
              kind="allow"
              className="rounded bg-primary/15 px-2 py-0.5 text-xs font-semibold uppercase text-primary"
            >
              {allowLabel}
            </Badge>
          ) : (
            <Badge
              kind={rejectionKind}
              className="rounded bg-danger/15 px-2 py-0.5 text-xs font-semibold uppercase text-danger"
            >
              {rejectionLabel}
            </Badge>
          )}
          <span className="font-mono text-sm text-soft-white">
            {denial.service !== 'firestore' ? `${denial.service} · ` : ''}
            {denial.method} {denial.path}
          </span>
          {denial.database ? (
            <span
              data-pyric-ui="denial-database-chip"
              className="rounded border border-border bg-content-bg px-1.5 py-0.5 font-mono text-xs text-slate-gray"
            >
              {denial.database} ({firestoreRulesetLabel(denial.database)})
            </span>
          ) : null}
        </div>
        {advisoryLead === undefined ? null : (
          <p data-pyric-ui="denial-detail-advisory" className="mb-1 text-sm leading-relaxed text-soft-white">
            {advisoryLead}
          </p>
        )}
        <p className="text-sm leading-relaxed text-soft-white">{exp.headline}</p>
      </section>

      {exp.noEvaluation ? (
        /* Honesty guard: an "allow" with NO recorded rules evaluation (admin
           bypass from a worker that didn't stamp its lens, or a mislabel).
           The headline above says so; no matched-rule box, no ✓ marker, no
           trace, no re-runs — they would contradict the facts. The request
           context below is still shown: it's honest data. */
        <p
          data-pyric-ui="rules-debug-no-evaluation"
          className="rounded-md border border-border bg-content-bg px-3 py-2 text-xs text-slate-gray"
        >
          No matched rule, evaluation trace, or re-run is shown because this
          event carries no rules verdict to ground them in.
        </p>
      ) : (
        <>
          <ServiceRuleDetail
            denial={denial}
            exp={exp}
            rulesSource={rulesSource}
            renderTraceStep={(step) => <TraceStepRow step={step} />}
          />

          <TraceWork denial={denial} />
        </>
      )}

      {/* What the rule saw: request/resource variables, inspectable + honest
          about anything not captured for this denial. */}
      <VariablesInspector denial={denial} />
    </div>
  );
}

function TraceWork({ denial }: { denial: Denial }) {
  const steps = projectTraceSteps(denial);
  if (steps.length === 0) return null;
  let traceLabel = 'show the work \u2014 how the condition evaluated';
  if (queryProofFailure(denial)) {
    traceLabel = 'residual evaluation \u2014 separate from the static proof';
  }
  return (
    <RulesField label={traceLabel}>
      <div
        data-pyric-ui="rules-debug-trace"
        className="flex flex-col gap-0.5 overflow-auto rounded-md border border-border bg-content-bg p-3"
      >
        {steps.map((s, i) => (
          <TraceStepRow key={i} step={s} />
        ))}
      </div>
    </RulesField>
  );
}

const OUTCOME_MARK: Record<TraceStep['outcome'], string> = {
  true: '✓',
  false: '✗',
  skipped: '⊘',
  error: '!',
  unsupported: '?',
  value: '·',
};

function TraceStepRow({ step }: { step: TraceStep }) {
  const markClass =
    step.outcome === 'true'
      ? 'text-diff-add'
      : step.outcome === 'false' || step.outcome === 'error'
        ? 'text-danger'
        : 'text-slate-gray';
  const valueText =
    step.outcome === 'skipped'
      ? 'not evaluated (short-circuit)'
      : step.outcome === 'error'
        ? step.error
        : step.outcome === 'unsupported'
          ? `unsupported${step.error ? `: ${step.error}` : ''}`
          : `→ ${formatValue(step.value)}`;
  return (
    <>
      <div
        className="flex items-baseline gap-2 font-mono text-xs"
        style={{ paddingLeft: `${step.depth * 0.9}rem` }}
      >
        <span aria-hidden className={`w-3 shrink-0 text-center font-bold ${markClass}`}>
          {OUTCOME_MARK[step.outcome]}
        </span>
        <span className={step.outcome === 'skipped' ? 'text-slate-gray line-through' : 'text-soft-white'}>
          {step.letBinding ? `let ${step.letBinding} = ` : ''}
          {step.source}
        </span>
        <span className="text-slate-gray">{valueText}</span>
        {step.inlinedFrom ? (
          <span className="text-[0.6rem] uppercase tracking-wide text-slate-gray">
            {step.inlinedFrom}()
          </span>
        ) : null}
      </div>
      {step.children.map((c, i) => (
        <TraceStepRow key={i} step={c} />
      ))}
    </>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(truncateVectorsForDisplay(value));
  } catch {
    return String(value);
  }
}

// ─── What the rule saw: read-only variable inspector ────────────────────────

/** The rules variables (`request.auth`, `request.resource.data`, `resource`, …)
 *  the denying rule evaluated against, as a read-only key:value tree. Values
 *  genuinely not captured for this denial are shown as honestly absent. */
function VariablesInspector({ denial }: { denial: Denial }) {
  const vars = ruleVariables(denial);
  return (
    <RulesField label="what the rule saw (request / resource)">
      <div
        data-pyric-ui="rules-debug-variables"
        className="flex flex-col gap-2 rounded-md border border-border bg-content-bg p-3"
      >
        {vars.map((v) => (
          <VariableRow key={v.name} variable={v} />
        ))}
      </div>
    </RulesField>
  );
}

function VariableRow({ variable }: { variable: RuleVariable }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[0.7rem] text-primary">{variable.name}</span>
      {variable.present ? (
        <ValueTree value={variable.value} />
      ) : (
        <span className="font-mono text-xs italic text-slate-gray">
          absent{variable.absentNote ? ` — ${variable.absentNote}` : ''}
        </span>
      )}
    </div>
  );
}

/** A compact read-only tree over an arbitrary JSON-ish value. Scalars render
 *  inline; objects/arrays render as an expandable disclosure (default open at
 *  the top level). Read-only — the doctree idiom for "what the rule saw." */
function ValueTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const truncated = truncateVectorsForDisplay(value);
  if (truncated === null || typeof truncated !== 'object') {
    return <span className="font-mono text-xs text-soft-white">{formatValue(truncated)}</span>;
  }
  const entries = Array.isArray(truncated)
    ? truncated.map((v, i) => [String(i), v] as const)
    : Object.entries(truncated as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="font-mono text-xs text-slate-gray">{Array.isArray(truncated) ? '[]' : '{}'}</span>;
  }
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 font-mono text-xs text-slate-gray hover:text-soft-white"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span>{Array.isArray(truncated) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 border-l border-border pl-3">
          {entries.map(([k, v]) => (
            <div key={k} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-slate-gray">{k}:</span>
              <ValueTree value={v} depth={depth + 1} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
