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
  denialSeverity,
  rerunSupport,
  shouldOfferImpersonation,
  projectTraceSteps,
  ruleVariables,
  type Denial,
  type DenialSeverity,
  type RuleExplanation,
  type RerunSupport,
  type TraceStep,
  type RuleVariable,
} from './model.js';
import type { EditedRulesetRerun, RerunResult } from './rerun.js';
import { LazyRulesCodeEditor } from './LazyRulesCodeEditor.js';

const SEVERITY_DOT: Record<DenialSeverity, string> = {
  low: 'bg-severity-low',
  medium: 'bg-severity-medium',
  high: 'bg-severity-high',
};

export interface RulesDebugProps {
  /** Denied ops, newest first (from `selectDenials(events)`). */
  denials: readonly Denial[];
  /** Currently-edited ruleset for the "what if" re-run (controlled by the host).
   *  When absent, the edited-ruleset panel offers to start from the live rules. */
  editedRules?: string;
  /** The DEPLOYED ruleset source, for the read-only "what happened" view (shown
   *  with the denying line marked). Independent of `editedRules` so edits don't
   *  rewrite the record of what actually ran. */
  rulesSource?: string;
  onEditedRulesChange?: (rules: string) => void;
  /** Re-run the selected denial AS the attempting user (impersonation, live). */
  onRerunAsUser?: (denial: Denial) => Promise<RerunResult>;
  /** Re-run the selected denial against `editedRules` (fork + lint + diff). */
  onRerunAgainstRules?: (denial: Denial, rules: string) => Promise<EditedRulesetRerun>;
  /** Shown when there are no denials yet (backend-aware copy from the pane). */
  emptyState?: ReactNode;
}

export function RulesDebug({
  denials,
  editedRules,
  rulesSource,
  onEditedRulesChange,
  onRerunAsUser,
  onRerunAgainstRules,
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
          editedRules={editedRules}
          rulesSource={rulesSource}
          onEditedRulesChange={onEditedRulesChange}
          onRerunAsUser={onRerunAsUser}
          onRerunAgainstRules={onRerunAgainstRules}
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
 * The single-denial inspection detail: per-service rule explanation,
 * request.auth, the data the rule saw, and the two capability-gated re-runs.
 * Exported pure-props so other surfaces can mount ONE denial's inspection
 * without the list layout — the Traffic surface renders this as a deny row's
 * expanded detail (`features/traffic/TrafficDenialInspector.tsx`).
 */
export function DenialDetail({
  denial,
  editedRules,
  rulesSource,
  onEditedRulesChange,
  onRerunAsUser,
  onRerunAgainstRules,
}: {
  denial: Denial;
  editedRules?: string;
  rulesSource?: string;
  onEditedRulesChange?: (rules: string) => void;
  onRerunAsUser?: (denial: Denial) => Promise<RerunResult>;
  onRerunAgainstRules?: (denial: Denial, rules: string) => Promise<EditedRulesetRerun>;
}) {
  const exp = explainDenial(denial);
  return (
    <div
      data-pyric-ui="denial-detail"
      className="flex min-h-0 flex-col gap-4 overflow-auto rounded-lg border border-border bg-sidebar-bg p-5"
    >
      {/* The denial headline + the rule that denied it. */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Badge
            kind="deny"
            className="rounded bg-danger/15 px-2 py-0.5 text-xs font-semibold uppercase text-danger"
          >
            {denial.unsupported ? 'unsupported' : 'denied'}
          </Badge>
          <span className="font-mono text-sm text-soft-white">
            {denial.service !== 'firestore' ? `${denial.service} · ` : ''}
            {denial.method} {denial.path}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-soft-white">{exp.headline}</p>
      </section>

      {/* Per-service rule detail, grounded in that service's mechanical trace.
          For Firestore this includes the read-only "what happened" view of the
          deployed ruleset with the denying line marked (✗). */}
      <RuleDetail denial={denial} exp={exp} rulesSource={rulesSource} />

      {/* Show the work: the denying rule's sub-expression evaluation. */}
      <TraceWork denial={denial} />

      {/* What the rule saw: request/resource variables, inspectable + honest
          about anything not captured for this denial. */}
      <VariablesInspector denial={denial} />

      {/* Re-run actions. */}
      <RerunPanel
        denial={denial}
        editedRules={editedRules}
        onEditedRulesChange={onEditedRulesChange}
        onRerunAsUser={onRerunAsUser}
        onRerunAgainstRules={onRerunAgainstRules}
      />
    </div>
  );
}

/** The service-specific slice of the detail: the exact rule node, in that
 *  engine's own terms, plus whatever extra structure that engine's mechanical
 *  tooling hands us (RTDB bindings/expression; Firestore/Storage trace lines). */
function RuleDetail({
  denial,
  exp,
  rulesSource,
}: {
  denial: Denial;
  exp: RuleExplanation;
  rulesSource?: string;
}) {
  if (exp.engine === 'rtdb') return <RtdbRuleDetail denial={denial} exp={exp} />;
  if (exp.engine === 'storage') return <StorageRuleDetail exp={exp} />;
  return <FirestoreRuleDetail denial={denial} exp={exp} rulesSource={rulesSource} />;
}

/** Firestore: the matched `Rule #N (ops)` node, the deployed ruleset shown
 *  read-only with the denying line marked (✗ gutter + tinted line), and — when
 *  no sub-expression trace is available — the raw simulator trace lines. */
function FirestoreRuleDetail({
  denial,
  exp,
  rulesSource,
}: {
  denial: Denial;
  exp: RuleExplanation;
  rulesSource?: string;
}) {
  const line = denial.denyingRule?.line;
  const showSource = !!rulesSource && rulesSource.trim().length > 0;
  return (
    <Field
      label={
        exp.implicitDeny
          ? 'matched rule'
          : `matched rule — ${exp.ruleNode}${line ? ` · line ${line}` : ''}`
      }
    >
      {showSource ? (
        <LazyRulesCodeEditor
          value={rulesSource!}
          readOnly
          denialLine={line}
          minHeightRem={12}
          ariaLabel="Deployed firestore.rules — the denying rule is marked"
        />
      ) : (
        <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
          {[...exp.ruleLines, ...exp.otherLines].join('\n') || '(no trace)'}
        </pre>
      )}
    </Field>
  );
}

// ─── Show the work: sub-expression evaluation step-through ──────────────────

/** The heart of the page: the denying rule's condition rendered as an
 *  evaluated tree — each sub-expression with its value, the false branch marked
 *  ✗, short-circuited operands greyed as skipped. Firestore-only (the simulator
 *  is the only engine that emits a sub-expression trace); absent otherwise. */
function TraceWork({ denial }: { denial: Denial }) {
  const steps = projectTraceSteps(denial);
  if (steps.length === 0) return null;
  return (
    <Field label="show the work — how the condition evaluated">
      <div
        data-pyric-ui="rules-debug-trace"
        className="flex flex-col gap-0.5 overflow-auto rounded-md border border-border bg-content-bg p-3"
      >
        {steps.map((s, i) => (
          <TraceStepRow key={i} step={s} />
        ))}
      </div>
    </Field>
  );
}

const OUTCOME_MARK: Record<TraceStep['outcome'], string> = {
  true: '✓',
  false: '✗',
  skipped: '⊘',
  error: '!',
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
    <Field label="what the rule saw (request / resource)">
      <div
        data-pyric-ui="rules-debug-variables"
        className="flex flex-col gap-2 rounded-md border border-border bg-content-bg p-3"
      >
        {vars.map((v) => (
          <VariableRow key={v.name} variable={v} />
        ))}
      </div>
    </Field>
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

/** RTDB: WHICH node in the cascade denied (`.write` vs `.validate`, at which
 *  rule-tree path), its raw rule text, and the `$variable` bindings —
 *  `SimulateHandler`'s verdict, not a re-derivation. */
function RtdbRuleDetail({ denial, exp }: { denial: Denial; exp: RuleExplanation }) {
  return (
    <>
      <Field label={exp.implicitDeny ? 'rule node' : `rule node — ${exp.ruleNode}`}>
        <code className="font-mono text-xs text-soft-white">
          {exp.phase ? `.${exp.phase}` : '(no matching rule)'}
          {denial.rules?.matchedPath ? ` at ${denial.rules.matchedPath}` : ''}
        </code>
      </Field>
      {exp.ruleExpression ? (
        <Field label="rule expression">
          <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs text-slate-gray">
            {exp.ruleExpression}
          </pre>
        </Field>
      ) : null}
      {exp.bindings ? (
        <Field label="$variable bindings">
          <code className="font-mono text-xs text-soft-white">
            {Object.entries(exp.bindings)
              .map(([k, v]) => `${k.startsWith('$') ? k : `$${k}`} → ${v}`)
              .join(', ')}
          </code>
        </Field>
      ) : null}
      {denial.rules?.reason ? (
        <Field label="simulator reason">
          <code className="font-mono text-xs text-slate-gray">{denial.rules.reason}</code>
        </Field>
      ) : null}
    </>
  );
}

/** Storage: the `match` block + verb whose condition failed, and the raw
 *  free-text reasons `evaluateStorageRules` produced (no rule index/trace —
 *  the Storage engine doesn't build one; see `SPEC.md`). */
function StorageRuleDetail({ exp }: { exp: RuleExplanation }) {
  return (
    <Field label={exp.implicitDeny ? 'matched rule' : 'matched rule (match block)'}>
      {exp.ruleNode ? (
        <code className="mb-2 block font-mono text-xs text-soft-white">{exp.ruleNode}</code>
      ) : null}
      <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
        {[...exp.ruleLines, ...exp.otherLines].join('\n') || '(no trace)'}
      </pre>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-gray">
        {label}
      </span>
      {children}
    </div>
  );
}

// ─── Re-run panel (both paths, capability-gated per service) ──────────────

function RerunPanel({
  denial,
  editedRules,
  onEditedRulesChange,
  onRerunAsUser,
  onRerunAgainstRules,
}: {
  denial: Denial;
  editedRules?: string;
  onEditedRulesChange?: (rules: string) => void;
  onRerunAsUser?: (denial: Denial) => Promise<RerunResult>;
  onRerunAgainstRules?: (denial: Denial, rules: string) => Promise<EditedRulesetRerun>;
}) {
  const [asUser, setAsUser] = useState<RerunResult | 'pending' | null>(null);
  const [edited, setEdited] = useState<EditedRulesetRerun | 'pending' | null>(null);

  const support = rerunSupport(denial);
  const canImpersonate =
    support.impersonate.kind === 'live' && !!onRerunAsUser && !!denial.auth?.uid;
  const canEdited = support.editedRuleset.kind === 'live' && !!onRerunAgainstRules;

  async function runAsUser() {
    if (!onRerunAsUser) return;
    setAsUser('pending');
    try {
      setAsUser(await onRerunAsUser(denial));
    } catch (e) {
      setAsUser({ outcome: 'error', code: 'unknown', message: String(e) });
    }
  }

  async function runEdited() {
    if (!onRerunAgainstRules) return;
    setEdited('pending');
    try {
      setEdited(await onRerunAgainstRules(denial, editedRules ?? ''));
    } catch (e) {
      setEdited({
        result: { outcome: 'error', code: 'unknown', message: String(e) },
        diff: [],
        lint: { parseable: true, findings: [] },
      });
    }
  }

  return (
    <section
      data-pyric-ui="rerun-panel"
      className="mt-1 flex flex-col gap-4 border-t border-border pt-4"
    >
      {/* Path 1: re-run as the attempting user. Only meaningful when there IS a
          user: for an unauthenticated denial (request.auth == null) there is no
          different identity to run as, so the row is dropped entirely rather
          than shown disabled — re-running as the SAME (absent) user isn't
          impersonation. A future "run as a DIFFERENT user" picker is the real
          impersonation design (see SPEC.md). */}
      {shouldOfferImpersonation(denial) ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-soft-white">
              Re-run as the attempting user
            </span>
            <button
              type="button"
              disabled={!canImpersonate || asUser === 'pending'}
              onClick={runAsUser}
              className="rounded-md border border-primary/40 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-slate-gray"
            >
              {asUser === 'pending'
                ? 'Running…'
                : support.impersonate.kind === 'live'
                  ? `Impersonate ${denial.auth?.uid ?? ''}`
                  : 'Impersonation not available'}
            </button>
          </div>
          <RerunHint support={support.impersonate} haveCallback={!!onRerunAsUser} />
          {asUser && asUser !== 'pending' ? <ResultLine result={asUser} /> : null}
        </div>
      ) : null}

      {/* Path 2: re-run against an edited ruleset (lint + fork + diff). */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-soft-white">
            Re-run against an edited ruleset
          </span>
          <button
            type="button"
            disabled={!canEdited || edited === 'pending'}
            onClick={runEdited}
            className="rounded-md border border-primary/40 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:border-border disabled:text-slate-gray"
          >
            {edited === 'pending' ? 'Linting + forking…' : 'Lint, then test on a branch'}
          </button>
        </div>
        {onEditedRulesChange && support.editedRuleset.kind === 'live' ? (
          <LazyRulesCodeEditor
            value={editedRules ?? ''}
            onChange={onEditedRulesChange}
            denialLine={denial.denyingRule?.line}
            minHeightRem={14}
            ariaLabel="Edited firestore.rules to test the denied op against"
          />
        ) : null}
        <RerunHint support={support.editedRuleset} haveCallback={!!onRerunAgainstRules} />
        {edited && edited !== 'pending' ? (
          <>
            {edited.lint.findings.length > 0 || !edited.lint.parseable ? (
              <LintFindings lint={edited.lint} />
            ) : null}
            <ResultLine result={edited.result} />
            {edited.diff.length > 0 ? <DiffView diff={edited.diff} /> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** Renders the capability gate for one re-run path: nothing when it's `live`
 *  and wired, the standard "needs the live backend" hint when it's `live` but
 *  the host hasn't supplied a callback yet, and the mechanical-tool-naming
 *  hint when the service's tooling itself doesn't back this path yet
 *  (`pending`/`absent` — see `SPEC.md`). */
function RerunHint({ support, haveCallback }: { support: RerunSupport; haveCallback: boolean }) {
  if (support.kind === 'pending' || support.kind === 'absent') {
    const tool = support.kind === 'pending' ? support.tool : support.missingTool;
    return (
      <p
        data-pyric-ui="rerun-hint-gated"
        className="rounded-md border border-border bg-content-bg px-3 py-2 text-xs text-slate-gray"
      >
        {support.hint}{' '}
        <code className="font-mono text-[0.7rem] text-warning">{tool}</code>
      </p>
    );
  }
  if (!haveCallback) {
    return (
      <p className="rounded-md border border-border bg-content-bg px-3 py-2 text-xs text-slate-gray">
        Wired to the live sandbox once the local backend is reachable. The
        denial, rule, and context above are already live.
      </p>
    );
  }
  return null;
}

function LintFindings({ lint }: { lint: EditedRulesetRerun['lint'] }) {
  return (
    <div
      data-pyric-ui="rerun-lint"
      className="flex flex-col gap-1 rounded-md border border-border bg-content-bg p-3"
    >
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-gray">
        lint (firestore_lint_rules)
      </span>
      {!lint.parseable ? (
        <p className="font-mono text-xs text-danger">{lint.parseError}</p>
      ) : (
        lint.findings.map((f, i) => (
          <p key={`${f.rule}-${i}`} className="font-mono text-xs">
            <span className={f.severity === 'error' ? 'text-danger' : 'text-warning'}>
              {f.rule}
            </span>
            <span className="text-slate-gray"> — {f.message}</span>
          </p>
        ))
      )}
    </div>
  );
}

function ResultLine({ result }: { result: RerunResult }) {
  if (result.outcome === 'allow') {
    return (
      <p className="flex items-center gap-2 text-xs">
        <Badge kind="allow" className="rounded bg-primary/15 px-2 py-0.5 font-semibold uppercase text-primary">
          allow
        </Badge>
        <span className="text-slate-gray">The op is now permitted.</span>
      </p>
    );
  }
  if (result.outcome === 'deny') {
    return (
      <p className="flex items-center gap-2 text-xs">
        <Badge kind="deny" className="rounded bg-danger/15 px-2 py-0.5 font-semibold uppercase text-danger">
          deny
        </Badge>
        <span className="text-slate-gray">Still denied: {result.message}</span>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-xs">
      <Badge kind="error" className="rounded bg-warning/15 px-2 py-0.5 font-semibold uppercase text-warning">
        {result.code}
      </Badge>
      <span className="text-slate-gray">{result.message}</span>
    </p>
  );
}

// ─── Diff view (branch vs live) ────────────────────────────────────────────

/** Uniform render shape over the `Divergence` union. A branch-vs-live diff only
 *  produces `real-divergence` (the branches primitive's documented behaviour),
 *  but the engine's `Divergence` type also includes replay-only variants
 *  (`autoid-alias`): this flattens every case to `{ path, field?, before, after }`
 *  so the view is total over the union. */
type DiffRow = { path: string; field?: string; before: unknown; after: unknown };

function toDiffRow(dv: EditedRulesetRerun['diff'][number]): DiffRow {
  if (dv.kind === 'autoid-alias') {
    return { path: dv.originalPath, before: dv.originalPath, after: dv.replayedPath };
  }
  return {
    path: dv.path,
    ...('field' in dv && dv.field ? { field: dv.field } : {}),
    before: dv.before,
    after: dv.after,
  };
}

function DiffView({ diff }: { diff: EditedRulesetRerun['diff'] }) {
  return (
    <div
      data-pyric-ui="rules-debug-diff"
      className="flex flex-col gap-1 rounded-md border border-border bg-content-bg p-3"
    >
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-gray">
        what the re-run changed (branch vs live)
      </span>
      {diff.map((raw, i) => {
        const dv = toDiffRow(raw);
        const field = dv.field ? `.${dv.field}` : '';
        const added = dv.before === undefined && dv.after !== undefined;
        const removed = dv.before !== undefined && dv.after === undefined;
        return (
          <div key={`${dv.path}-${i}`} className="font-mono text-xs">
            <span
              className={
                added
                  ? 'text-diff-add'
                  : removed
                    ? 'text-diff-remove'
                    : 'text-warning'
              }
            >
              {added ? '+ ' : removed ? '- ' : '~ '}
              {dv.path}
              {field}
            </span>
            {!added ? (
              <span className="ml-2 text-slate-gray">
                {JSON.stringify(truncateVectorsForDisplay(dv.before))}
              </span>
            ) : null}
            {!removed ? (
              <span className="ml-2 text-soft-white">
                → {JSON.stringify(truncateVectorsForDisplay(dv.after))}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
