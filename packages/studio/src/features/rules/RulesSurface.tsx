/**
 * Rules surface (S-RULES): `mocks/c-debug.html` as a live surface.
 *
 * THE DENIAL INSPECTOR. This composes the canonical `@pyric/ui/rules`
 * `DenialInspector` (NOT a Studio reimplementation) and feeds it from the
 * unified Studio data source. The seam:
 *
 *   1. The denied requests are the `kind: 'request'` / `result: 'deny'` slice
 *      of the unified event stream (`useStudioEvents()`: the dev-seed in review,
 *      the live SharedWorker feed under `pyric dev --ui`). Each carries the
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
import type { RequestEvent, SandboxEvent } from 'pyric/sandbox';
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
} from '../../shell/studio-data.js';
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
  onSelectCluster,
}: {
  op: DeniedOp;
  rulesSource: string;
  cluster: DeniedOp[];
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

  return (
    <DenialInspector
      denial={denial}
      cluster={clusterDenials}
      className="rules__inspector"
      onSelectCluster={(d) => {
        const id = (d as unknown as { __id?: string }).__id;
        if (id) onSelectCluster(id);
      }}
    />
  );
}

export function RulesSurface() {
  const seed = useDevSeed();
  const events = useStudioEvents();
  const rulesSource = useStudioRulesSource();
  const nav = useDataNav();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A Session activity row / "Debug" jump sets the denial to focus; adopt it as
  // the local selection. Cluster clicks (setSelectedId) take over afterward; a
  // fresh jump (new id) re-applies. Mirrors how the data surfaces honor a
  // cross-ref target.
  useEffect(() => {
    if (nav.selectedInspectId) setSelectedId(nav.selectedInspectId);
  }, [nav.selectedInspectId]);

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
        onSelectCluster={setSelectedId}
      />
    </section>
  );
}
