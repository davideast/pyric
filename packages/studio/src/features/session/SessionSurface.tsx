/**
 * Session surface (S-SESSION): `mocks/c-result.html` as a live surface.
 *
 * The mechanical session view: **action items first** (denials → Debug), then
 * the **Activity** grid, the unified `SandboxEvent` stream folded into category
 * bands (Denied / Added / Updated / …), each a `target · change · for · lens ·
 * when` column grid. Denials lead (lead-with-consequence).
 *
 * Both parts are `@pyric/ui/events` (ActivityActionItems + ActivityGrid) over
 * one memoized digest; Studio supplies the c-result CSS via the data-pyric
 * contract and the Debug affordance that links into the Rules surface.
 */

import { useState, useRef, type ChangeEvent } from 'react';
import { ActivityActionItems, ActivityGrid, useActivityDigest } from '@pyric/ui/events';
import type { ActivityRow, AnyActivityEvent } from '@pyric/ui/events';
import { useDataNav, parseDocPath } from '../data/navigation.js';
import {
  useStudioEvents,
  useStudioReset,
  useSandboxInstanceId,
  useStudioExport,
  useStudioImport,
  useStudioBranches,
} from '../../shell/studio-data.js';
import { instanceSlug } from '../../shell/instance-slug.js';
import { useProposals, focusProposal } from '../proposals/proposals.js';
import '../proposals/proposals.css';
import './session.css';

export function SessionSurface() {
  const reset = useStudioReset();
  const [resetting, setResetting] = useState(false);
  // The unified stream IS the activity source (dev-seed in review, the live
  // SharedWorker feed under `pyric dev --ui`); the events lib's types mirror
  // the sandbox's `request`/`write`/`service_mutation` shapes structurally.
  const events = useStudioEvents() as unknown as readonly AnyActivityEvent[];
  const digest = useActivityDigest(events);
  // Which sandbox INSTANCE is this? Same port in another browser profile is a
  // separate sandbox; the slug lets a user tell them apart (empty in review).
  const slug = instanceSlug(useSandboxInstanceId());
  const nav = useDataNav();
  const { open: proposals } = useProposals();

  // Transfer (Phase 2): export this sandbox's full state to a file, or import
  // (clobber) another instance's file into this one. Both are no-ops in review
  // (no live worker); import is destructive, so it confirms first.
  const exportState = useStudioExport();
  const importState = useStudioImport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const onExport = async () => {
    const bundle = await exportState();
    if (!bundle || typeof document === 'undefined') return;
    const url = URL.createObjectURL(new Blob([bundle], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pyric-sandbox-${slug || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Import REPLACES all data in this sandbox. This cannot be undone. Continue?')
    ) {
      return;
    }
    setImporting(true);
    try {
      await importState(await file.text());
    } finally {
      setImporting(false);
    }
  };

  // Named branches (Phase 3): saved states of THIS instance you can switch
  // between. Switch is a clobber, so it confirms; save prompts for a name.
  const branches = useStudioBranches();
  const onSaveBranch = async () => {
    const name = typeof window !== 'undefined' ? window.prompt('Save current sandbox as a branch named:')?.trim() : '';
    if (name) await branches.save(name);
  };
  const onSwitchBranch = async (name: string) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Switch to branch "${name}"? This REPLACES the current sandbox state.`)
    ) {
      return;
    }
    await branches.switchTo(name);
  };
  const onDeleteBranch = async (name: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete branch "${name}"?`)) return;
    await branches.remove(name);
  };

  const denialCount = digest.denials.length;

  // Open the Review surface focused on a staged proposal. Changes are produced
  // by the command-spine prompt (the agent), not a button here.
  const openReview = (id: string) => {
    focusProposal(id);
    if (typeof window !== 'undefined') window.location.hash = 'review';
  };

  // Every operation is a link to its subject. Denials route to the Rules
  // debugger for that exact denial (the actionable destination: why it was
  // blocked); everything else routes to the resource it touched in the owning
  // service surface. Tapping the whole row keeps a large, mobile-friendly target.
  const routeRow = (row: ActivityRow) => {
    if (row.denied) {
      nav.navigateDenial(row.id);
      return;
    }
    if (!row.target) return;
    switch (row.service) {
      case 'firestore':
        nav.navigate({ view: 'firestore', path: parseDocPath(row.target) });
        break;
      case 'auth':
        nav.navigate({ view: 'auth', uid: row.target });
        break;
      case 'storage':
        nav.navigate({ view: 'storage', objectPath: row.target });
        break;
      // rtdb has no surface yet: no-op (the row stays inert).
    }
  };

  return (
    <section className="session" data-pyric-ui="session">
      {/* Session context, relocated off the top bar: the sandbox lifecycle +
          Reset live with the session they describe. Counts are derived from the
          live stream. Changes are produced by the command-spine prompt (⌘K). */}
      <div className="session__meta">
        <span className="session__meta-text">
          sandbox
          {slug ? (
            <>
              {' '}
              <span
                className="mono session__instance"
                title="This sandbox lives in this browser profile; the same URL in another profile or incognito is a separate instance."
              >
                {slug}
              </span>
            </>
          ) : null}{' '}
          · started <span className="mono">just now</span> ·{' '}
          <span className="mono">{digest.total}</span>{' '}
          {digest.total === 1 ? 'change' : 'changes'}
        </span>
        <span className="session__meta-actions">
          <button type="button" className="session__reset" onClick={onExport}>
            Export
          </button>
          <button
            type="button"
            className="session__reset"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onImportFile}
          />
          <button type="button" className="session__reset" onClick={onSaveBranch}>
            Save branch
          </button>
          <button
            type="button"
            className="session__reset"
            disabled={resetting}
            onClick={async () => {
              setResetting(true);
              try {
                await reset();
              } finally {
                setResetting(false);
              }
            }}
          >
            {resetting ? 'Resetting…' : 'Reset session'}
          </button>
        </span>
      </div>

      {/* Named branches (Phase 3): saved states of THIS instance. Switching is a
          clobber; the bundles live in the worker's local IDB. */}
      {branches.branches.length > 0 ? (
        <div className="session__branches">
          <span className="session__branches-label">Branches</span>
          {branches.branches.map((name) => (
            <span key={name} className="session__branch">
              <span className="session__branch-name mono">{name}</span>
              <button type="button" className="session__reset" onClick={() => onSwitchBranch(name)}>
                Switch
              </button>
              <button type="button" className="session__reset" onClick={() => onDeleteBranch(name)}>
                Delete
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Staged changes: open proposals (a change run on a copy, awaiting your
          decision). The most actionable thing, so it leads. */}
      {proposals.length > 0 ? (
        <section className="session__panel session__panel--attention">
          <header className="session__head">
            <h2 className="session__title">Staged changes</h2>
            <span className="session__count">{proposals.length}</span>
          </header>
          <div className="session__actions">
            {proposals.map((p) => (
              <div key={p.id} className="session__staged-item">
                <div className="session__staged-what">
                  <div className="session__staged-title">{p.title}</div>
                  <div className="session__staged-meta">on a copy, not applied · staged by {p.actor}</div>
                </div>
                <button
                  type="button"
                  className="session__actlink"
                  onClick={() => openReview(p.id)}
                >
                  Review →
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Needs attention: a single condensed panel that gathers every item
          wanting a decision (denials → Debug). One UI, many actions. */}
      {denialCount > 0 ? (
        <section className="session__panel session__panel--attention">
          <header className="session__head">
            <h2 className="session__title">Needs attention</h2>
            <span className="session__count">{denialCount}</span>
          </header>
          <ActivityActionItems
            digest={digest}
            className="session__actions"
            renderAction={(item) => (
              <button
                type="button"
                className="session__actlink"
                onClick={() => {
                  // Drill into the Rules debugger, focused on this cluster's
                  // first denial (its event id correlates to the denial).
                  const id = item.rows[0]?.id;
                  if (id) nav.navigateDenial(id);
                }}
              >
                Debug →
              </button>
            )}
          />
        </section>
      ) : null}

      {/* Activity: everything that changed, by category. */}
      <section className="session__panel">
        <header className="session__head">
          <h2 className="session__title">Activity</h2>
          <span className="session__count">{digest.total}</span>
        </header>
        <ActivityGrid
          digest={digest}
          className="session__grid"
          onSelect={routeRow}
          maxRowsPerBand={4}
          emptyState={
            <p className="session__empty">
              No activity yet. As the app, an agent, or an admin changes the
              backend, a categorized digest of what changed shows up here.
            </p>
          }
        />
      </section>
    </section>
  );
}
