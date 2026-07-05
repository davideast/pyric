/**
 * Rules surface (S-RULES): `mocks/c-debug.html` as a live surface.
 *
 * THE DENIAL INSPECTOR. This composes the canonical `@pyric/ui/rules`
 * `DenialInspector` (NOT a Studio reimplementation) and feeds it from the
 * unified Studio data source. The seam:
 *
 *   1. The denied requests are the `kind: 'request'` / `result: 'deny'` slice
 *      of the unified event stream (`useStudioEvents()`: the dev-seed in review,
 *      the live SharedWorker feed under `pyric serve --ui`). Each carries the
 *      captured op (method/path/auth) + payload (`request.resourceData`) +
 *      the existing doc the rule saw (`resourceBefore`).
 *   2. The rule source comes from `useStudioRulesSource()`: read straight off
 *      the live sandbox via `getInternalEnv(sandbox).getRules()` in review, or
 *      the deployed ruleset on `/__pyric/init.json` in served mode.
 *   3. Each captured request is re-run through the local rules simulator with
 *      `useDenialTrace(request, rulesSource)` (tracing always on) to recover the
 *      rich `evaluation` / `expressionTrace` the live `deny` event doesn't carry.
 *      That result, spread alongside the captured request fields, is the
 *      `@pyric/ui/rules` `Denial` the inspector renders.
 *
 * The first denial is shown in full; its same-rule siblings form the cluster.
 * Selecting a cluster item swaps the inspected denial. The re-run affordances
 * are wired as present-but-noop probes (the live impersonation path needs the
 * served worker client; the dev-seed has no worker), surfaced so the verify
 * loop reads true to the mock.
 *
 * Styling rides `rules.css`: token roles only, the `data-pyric-*` contract
 * from `denial-inspector-spec.md`, ported from `mocks/c-debug.html`.
 */

import { useEffect, useMemo, useState } from 'react';
import { fork, discard } from 'pyric/sandbox';
import type { RequestEvent, SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
import {
  DenialInspector,
  useDenialTrace,
  type Denial,
  type DenialRequest,
  type FirestoreMethod,
} from '@pyric/ui/rules';
import { useDevSeed } from '../../dev/DevSeedProvider.js';
import { useDataNav } from '../data/navigation.js';
import {
  useStudioEvents,
  useStudioRulesSource,
  useStudioDenials,
  useStudioSnapshot,
} from '../../shell/studio-data.js';
import {
  rerunAgainstRules,
  issueOp,
  type RerunResult,
  type EditedRulesetRerun,
} from '../rules-debug/rerun.js';
import type { Denial as ModelDenial } from '../rules-debug/model.js';
// NOTE: the AI assists (Explain this denial / Suggest a fix) were removed from
// this surface in the design pass. They were bolted on as orphan buttons at the
// end of the page with no real states. The engine (ai/useAssist, ai/explain,
// rules-fix) stays on disk; Phase 2 re-weaves it into the denial flow with real
// states (idle / thinking / streaming / result) instead of appended buttons.
import './rules.css';

/** A denied request event paired with the rule source it ran against. */
interface DeniedOp {
  /** Stable key + correlation (the originating request event id). */
  id: string;
  request: DenialRequest;
  at: number;
  path: string;
}

/** The rules vocabulary has no `set`: it lowers to create/update at eval
 *  time. Map the data-plane method onto the rules method the simulator wants. */
function toRulesMethod(method: RequestEvent['method'], hadExisting: boolean): FirestoreMethod {
  if (method === 'set') return hadExisting ? 'update' : 'create';
  return method;
}

/** Project a `result:'deny'` request event to the simulator's `DenialRequest`. */
function toDeniedOp(e: RequestEvent): DeniedOp {
  const resourceBefore = e.resourceBefore;
  const existing = resourceBefore?.exists ? resourceBefore.data : null;
  const request: DenialRequest = {
    method: toRulesMethod(e.method, resourceBefore?.exists ?? false),
    path: e.path,
    auth: e.auth,
    ...(e.request?.resourceData !== undefined
      ? { requestData: e.request.resourceData }
      : {}),
    ...(existing != null ? { resourceData: existing } : {}),
  };
  return { id: e.id, request, at: e.at, path: e.path };
}

function selectDeniedOps(events: readonly SandboxEvent[]): DeniedOp[] {
  return events
    .filter(
      (e): e is RequestEvent =>
        e.kind === 'request' && (e.result === 'deny' || e.result === 'unsupported'),
    )
    .map(toDeniedOp)
    .sort((a, b) => b.at - a.at); // newest first, the one you're debugging
}

/**
 * Build the `@pyric/ui/rules` `Denial` for one captured op by re-running the
 * simulator (`useDenialTrace`), then render it in the `DenialInspector`. A
 * thin child so the hook is called against the *selected* op only; cluster
 * siblings are passed through as lightweight `Denial`s (the inspector renders
 * just their path + re-selects on click, re-tracing the chosen one).
 */
function InspectedDenial({
  op,
  rulesSource,
  cluster,
  modelDenial,
  getSnapshot,
  onSelectCluster,
}: {
  op: DeniedOp;
  rulesSource: string;
  cluster: DeniedOp[];
  /** The rules-debug model of this op (from `selectDenials`), the input the
   *  re-run engine wants. Absent only if the projection missed it. */
  modelDenial: ModelDenial | undefined;
  /** Current sandbox snapshot getter (dev-seed or live worker) to fork from. */
  getSnapshot: () => Promise<SandboxSnapshot | null>;
  onSelectCluster(id: string): void;
}) {
  const trace = useDenialTrace(op.request, rulesSource);

  const denial = useMemo<Denial>(
    () => ({
      method: op.request.method,
      path: op.request.path,
      auth: op.request.auth
        ? { uid: op.request.auth.uid, token: op.request.auth.token ?? {} }
        : null,
      lens: op.request.auth ? { as: op.request.auth.uid } : 'app-session',
      ...(op.request.requestData !== undefined
        ? { requestData: op.request.requestData }
        : {}),
      ...(op.request.resourceData !== undefined
        ? { resourceData: op.request.resourceData }
        : {}),
      at: op.at,
      rulesSource,
      decision: 'DENY',
      evaluation: trace.evaluation,
      ...(trace.pathResolution ? { pathResolution: trace.pathResolution } : {}),
    }),
    [op, rulesSource, trace],
  );

  // Cluster siblings: lightweight Denials carrying just enough for the
  // inspector's cluster list (path) + the re-select correlation (carried on a
  // private field the inspector ignores). The chosen sibling is re-traced when
  // it becomes the selected op.
  const clusterDenials = useMemo<Denial[]>(
    () =>
      cluster.map((sib) => ({
        method: sib.request.method,
        path: sib.path,
        auth: sib.request.auth
          ? { uid: sib.request.auth.uid, token: sib.request.auth.token ?? {} }
          : null,
        at: sib.at,
        rulesSource,
        decision: 'DENY',
        evaluation: [],
        // correlation id for onSelectCluster: extra field, ignored by the UI.
        ...({ __id: sib.id } as Record<string, unknown>),
      })),
    [cluster, rulesSource],
  );

  // Re-run state. Scoped to this op: the parent re-keys InspectedDenial on
  // `op.id`, so a denial switch resets these cleanly.
  const [asResult, setAsResult] = useState<RerunResult | 'pending' | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editedRules, setEditedRules] = useState(rulesSource);
  const [editResult, setEditResult] = useState<EditedRulesetRerun | 'pending' | null>(null);

  // Both re-runs happen on a THROWAWAY fork of the current snapshot, so neither
  // mutates the live sandbox: (1) re-issue as the attempting user under the
  // CURRENT rules (reproduce + fresh decision), (2) re-issue under EDITED rules
  // and diff what the now-allowed write changed.
  async function runAsUser() {
    if (!modelDenial) return;
    setAsResult('pending');
    const snap = await getSnapshot();
    if (!snap) {
      setAsResult({ outcome: 'error', code: 'no-backend', message: 'No sandbox snapshot to re-run against.' });
      return;
    }
    const branch = fork(snap, rulesSource);
    try {
      setAsResult(await issueOp(branch.sandbox, modelDenial));
    } finally {
      discard(branch);
    }
  }

  async function runEdited() {
    if (!modelDenial) return;
    setEditResult('pending');
    const snap = await getSnapshot();
    if (!snap) {
      setEditResult({
        result: { outcome: 'error', code: 'no-backend', message: 'No sandbox snapshot to re-run against.' },
        diff: [],
      });
      return;
    }
    setEditResult(await rerunAgainstRules(snap, modelDenial, editedRules, snap));
  }

  return (
    <>
      <DenialInspector
        denial={denial}
        cluster={clusterDenials}
        className="rules__inspector"
        onRerunAs={() => {
          void runAsUser();
        }}
        onTestEditedRule={() => {
          // Prefill the editor with the live rules the first time it opens (the
          // served-mode rules source loads async, after this component's initial
          // state), so you edit from the current ruleset rather than a blank box.
          setEditedRules((prev) => (prev.trim() ? prev : rulesSource));
          setEditOpen((open) => !open);
        }}
        onSelectCluster={(d) => {
          const id = (d as unknown as { __id?: string }).__id;
          if (id) onSelectCluster(id);
        }}
      />

      {asResult ? (
        <div className="rules__rerun" data-pyric-ui="rules-rerun-as">
          <span className="rules__rerun-label">
            Re-run as {op.request.auth?.uid ?? 'the attempting user'}
          </span>
          {asResult === 'pending' ? (
            <span className="rules__rerun-pending">Running…</span>
          ) : (
            <RerunOutcome result={asResult} />
          )}
        </div>
      ) : null}

      {editOpen ? (
        <div className="rules__rerun" data-pyric-ui="rules-rerun-edit">
          <span className="rules__rerun-label">Test against an edited rule</span>
          <textarea
            className="rules__rerun-editor"
            value={editedRules}
            spellCheck={false}
            onChange={(e) => setEditedRules(e.target.value)}
          />
          <button
            type="button"
            className="rules__rerun-run"
            onClick={() => void runEdited()}
            disabled={editResult === 'pending'}
          >
            {editResult === 'pending' ? 'Running…' : 'Run against these rules'}
          </button>
          {editResult && editResult !== 'pending' ? (
            <>
              <RerunOutcome result={editResult.result} />
              {editResult.diff.length > 0 ? <RerunDiff diff={editResult.diff} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** One re-run outcome line: allow / deny / error. */
function RerunOutcome({ result }: { result: RerunResult }) {
  if (result.outcome === 'allow') {
    return (
      <p className="rules__rerun-outcome" data-pyric-outcome="allow">
        allow: the op is now permitted.
      </p>
    );
  }
  if (result.outcome === 'deny') {
    return (
      <p className="rules__rerun-outcome" data-pyric-outcome="deny">
        deny: {result.message}
      </p>
    );
  }
  return (
    <p className="rules__rerun-outcome" data-pyric-outcome="error">
      {result.code}: {result.message}
    </p>
  );
}

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

/** What the now-allowed write changed (branch vs live), compact. */
function RerunDiff({ diff }: { diff: EditedRulesetRerun['diff'] }) {
  return (
    <div className="rules__rerun-diff" data-pyric-ui="rules-rerun-diff">
      <span className="rules__rerun-difflabel">what the now-allowed write changed</span>
      {diff.map((dv, i) => {
        const row = toDiffRow(dv);
        const field = row.field ? `.${row.field}` : '';
        return (
          <div key={`${row.path}-${i}`} className="rules__rerun-diffrow">
            <span className="rules__rerun-diffpath">
              {row.path}
              {field}
            </span>
            <span className="rules__rerun-diffval">
              {JSON.stringify(row.before)} → {JSON.stringify(row.after)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function RulesSurface() {
  const seed = useDevSeed();
  const events = useStudioEvents();
  const rulesSource = useStudioRulesSource();
  const modelDenials = useStudioDenials();
  const getSnapshot = useStudioSnapshot();
  const nav = useDataNav();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A Session activity row / "Debug" jump sets the denial to focus; adopt it as
  // the local selection. Cluster clicks (setSelectedId) take over afterward; a
  // fresh jump (new id) re-applies. Mirrors how the data surfaces honor a
  // cross-ref target.
  useEffect(() => {
    if (nav.selectedDenialId) setSelectedId(nav.selectedDenialId);
  }, [nav.selectedDenialId]);

  const ops = useMemo<DeniedOp[]>(() => selectDeniedOps(events), [events]);

  const selected = useMemo(
    () => ops.find((o) => o.id === selectedId) ?? ops[0],
    [ops, selectedId],
  );
  const cluster = useMemo(
    () => (selected ? ops.filter((o) => o.id !== selected.id) : []),
    [ops, selected],
  );

  // Dev-seed still building its fixture: nothing to debug yet (review only).
  if (seed.status === 'pending') {
    return (
      <section data-pyric-ui="rules-surface" className="rules">
        <p className="rules__empty">Seeding the sandbox…</p>
      </section>
    );
  }

  // No denials in the stream yet. (The ruleset text may still be loading in
  // served mode; the inspector below tolerates an empty source and self-heals
  // once `/__pyric/init.json` resolves, so denials are never hidden on it.)
  if (!selected) {
    return (
      <section data-pyric-ui="rules-surface" className="rules">
        <p className="rules__empty">
          No denials yet. Denied reads and writes against the sandbox land here
          to debug.
        </p>
      </section>
    );
  }

  return (
    <section data-pyric-ui="rules-surface" className="rules">
      <header className="rules__head">
        <p className="rules__eyebrow">Debug a denial</p>
        <p className="rules__count">
          {ops.length} {ops.length === 1 ? 'denial' : 'denials'} this session
        </p>
      </header>
      <InspectedDenial
        // Re-key on the selected op so the per-op trace hook resets cleanly.
        key={selected.id}
        op={selected}
        rulesSource={rulesSource}
        cluster={cluster}
        modelDenial={modelDenials.find((d) => d.id === selected.id)}
        getSnapshot={getSnapshot}
        onSelectCluster={setSelectedId}
      />
    </section>
  );
}
