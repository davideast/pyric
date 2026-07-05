/**
 * Rules-failure debugging UI (Pyric Studio F4).
 *
 * Pure-props, like the `@pyric/ui` surfaces: it takes the list of {@link Denial}s
 * (projected from the event stream by `model.ts`) plus optional re-run callbacks,
 * and renders:
 *   - a LIST of denied ops (left), severity-ramped via `--color-severity-*`;
 *   - a DETAIL for the selected denial (right): the rule that denied it
 *     (`explainDenial`), the `request.auth` context, the resource path/op, and
 *     the proposed write;
 *   - two RE-RUN actions: "as the attempting user" (impersonation) and "against
 *     an edited ruleset" (a fork + diff). Each renders its {@link RerunResult}.
 *
 * Styling is token-only (`--color-danger`, the severity ramp, `--diff-*`) via
 * Tailwind v4 role classes, so it re-themes with the rest of the shell.
 *
 * The re-run callbacks are OPTIONAL: when the host hasn't wired the live worker
 * yet (T3 / Studio pane today), the buttons render disabled with a "needs the
 * live backend" hint; the denial→rule→context view is fully live regardless.
 */

import { useState, type ReactNode } from 'react';
import { Badge } from '@pyric/ui/primitives';
import { truncateVectorsForDisplay } from '@pyric/ui/firestore';
import {
  explainDenial,
  denialSeverity,
  type Denial,
  type DenialSeverity,
} from './model.js';
import type { EditedRulesetRerun, RerunResult } from './rerun.js';

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
  onEditedRulesChange?: (rules: string) => void;
  /** Re-run the selected denial AS the attempting user (impersonation, live). */
  onRerunAsUser?: (denial: Denial) => Promise<RerunResult>;
  /** Re-run the selected denial against `editedRules` (fork + diff). */
  onRerunAgainstRules?: (denial: Denial, rules: string) => Promise<EditedRulesetRerun>;
  /** Shown when there are no denials yet (backend-aware copy from the pane). */
  emptyState?: ReactNode;
}

export function RulesDebug({
  denials,
  editedRules,
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

function DenialDetail({
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
            {denial.method} {denial.path}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-soft-white">{exp.headline}</p>
      </section>

      {/* request.auth context. */}
      <Field label="request.auth">
        {denial.auth ? (
          <code className="font-mono text-xs text-soft-white">
            uid: {denial.auth.uid}
            {denial.auth.token
              ? ` · claims: ${Object.keys(denial.auth.token).join(', ') || 'none'}`
              : ''}
          </code>
        ) : (
          <code className="font-mono text-xs text-warning">
            null (unauthenticated)
          </code>
        )}
      </Field>

      {/* The rule trace: the "rule that denied it". */}
      <Field label="rule trace">
        <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
          {[...exp.ruleLines, ...exp.otherLines].join('\n') || '(no trace)'}
        </pre>
      </Field>

      {/* The proposed write, if any. */}
      {denial.resourceData ? (
        <Field label="request.resource.data (proposed write)">
          <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs text-soft-white">
            {JSON.stringify(truncateVectorsForDisplay(denial.resourceData), null, 2)}
          </pre>
        </Field>
      ) : null}

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

// ─── Re-run panel (both paths) ─────────────────────────────────────────────

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

  const canImpersonate = !!onRerunAsUser && !!denial.auth?.uid;
  const canEdited = !!onRerunAgainstRules;

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
      });
    }
  }

  return (
    <section
      data-pyric-ui="rerun-panel"
      className="mt-1 flex flex-col gap-4 border-t border-border pt-4"
    >
      {/* Path 1: re-run as the attempting user. */}
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
              : denial.auth?.uid
                ? `Impersonate ${denial.auth.uid}`
                : 'No user to impersonate'}
          </button>
        </div>
        {!onRerunAsUser ? (
          <HintNeedsBackend />
        ) : null}
        {asUser && asUser !== 'pending' ? <ResultLine result={asUser} /> : null}
      </div>

      {/* Path 2: re-run against an edited ruleset (fork + diff). */}
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
            {edited === 'pending' ? 'Forking…' : 'Test on a branch'}
          </button>
        </div>
        {onEditedRulesChange ? (
          <textarea
            value={editedRules ?? ''}
            onChange={(e) => onEditedRulesChange(e.target.value)}
            spellCheck={false}
            placeholder="Paste an edited firestore.rules to test the denied op against…"
            className="h-32 w-full resize-y rounded-md border border-border bg-content-bg p-3 font-mono text-xs text-soft-white outline-none focus:border-border-strong"
          />
        ) : null}
        {!onRerunAgainstRules ? <HintNeedsBackend /> : null}
        {edited && edited !== 'pending' ? (
          <>
            <ResultLine result={edited.result} />
            {edited.diff.length > 0 ? <DiffView diff={edited.diff} /> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function HintNeedsBackend() {
  return (
    <p className="rounded-md border border-border bg-content-bg px-3 py-2 text-xs text-slate-gray">
      Wired to the live sandbox once the local backend is reachable. The
      denial, rule, and context above are already live.
    </p>
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
