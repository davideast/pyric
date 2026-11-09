/**
 * Live-mode Observed Session Data banner + explicit opt-in sandbox seeding UI.
 *
 * Rendered at the top of Studio's Data and RTDB surfaces whenever Studio is
 * attached to a `@pyric/live` host (`useLiveHost() !== null`). Makes three
 * things unmistakable:
 *   1. The data shown below is partial and observed only from this live
 *      session's client and Admin SDK reads/writes in host memory (never a full
 *      production mirror, never persisted to `.pyric/` automatically).
 *   2. Inline edits remain refused (`PYRIC_LIVE_REFUSED`).
 *   3. Developers can explicitly opt in to seeding `.pyric/state/hosted` (with
 *      confirmation + `merge` / `replace` mode) or exporting a seed JSON file.
 */
import { useState } from 'react';
import type {
  ObservedSessionSkipStats,
  ObservedSessionSources,
} from '../shell/observed-session-parse.js';
import type {
  LiveSeedMode,
  LiveSeedSandboxResult,
  ObservedSessionViewState,
} from '../shell/use-observed-session-data.js';

/** `count` followed by the singular or plural noun, e.g. `1 item`, `3 items`. */
function countOf(count: number, singular: string, plural: string): string {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${plural}`;
}

function observedBadgeLabel(sources: ObservedSessionSources | undefined): string {
  if (sources !== undefined) {
    if (sources.client && sources.admin) {
      return 'Observed · Client + Admin · Partial · Read-only';
    }
    if (sources.admin) {
      return 'Observed · Admin · Partial · Read-only';
    }
    if (sources.client) {
      return 'Observed · Client · Partial · Read-only';
    }
  }
  return 'Observed this session · Partial · Read-only';
}

function skipSummaryParts(skips: ObservedSessionSkipStats | undefined): string[] {
  if (!skips) return [];
  const parts: string[] = [];
  if (skips.failed > 0) {
    parts.push(`${skips.failed} failed/denied ${skips.failed === 1 ? 'call' : 'calls'}`);
  }
  if (skips.admin > 0) {
    // Retained for wire compatibility with snapshots that report uncaptured Admin calls.
    parts.push(`${skips.admin} Admin SDK ${skips.admin === 1 ? 'call' : 'calls'}`);
  }
  if (skips.oversized > 0) {
    // The host counts items over its per-item and per-delta size caps here.
    parts.push(`${countOf(skips.oversized, 'item', 'items')} over the size cap`);
  }
  if (skips.unsupported > 0) {
    parts.push(
      `${countOf(skips.unsupported, 'uncaptured op', 'uncaptured ops')} (sentinels, converters, projections, field masks, or client transactions)`,
    );
  }
  if (skips.truncated > 0) {
    // The host counts truncated batches, evicted documents, and RTDB instances past its cap here.
    parts.push(`${countOf(skips.truncated, 'item', 'items')} dropped at the session budget`);
  }
  return parts;
}

/** The RTDB clause of the seed result line: empty when no RTDB instance was seeded. */
function seededRtdbClause(result: LiveSeedSandboxResult): string {
  if (result.seededRtdbInstances.length === 0) return '';
  return ` and RTDB (${result.seededRtdbInstances.join(', ')})`;
}

export interface LiveObservedDataBannerProps {
  observed: ObservedSessionViewState;
}

export function LiveObservedDataBanner({ observed }: LiveObservedDataBannerProps) {
  const { snapshot, seedLocalSandbox, downloadSeedJson } = observed;
  const { firestoreDocs, rtdbInstances, truncated, droppedCount } = snapshot.stats;
  const skipParts = skipSummaryParts(snapshot.skips);
  const hasAnyObservedData = firestoreDocs > 0 || rtdbInstances > 0;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mode, setMode] = useState<LiveSeedMode>('merge');
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<LiveSeedSandboxResult | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  const handleConfirmSeed = async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      const result = await seedLocalSandbox(mode);
      setSeedResult(result);
      setConfirmOpen(false);
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div
      data-pyric-ui="live-observed-banner"
      className="mb-3 rounded-md border border-line bg-panel p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-live-observed-badge=""
            className="rounded-full border border-line bg-elevated px-2.5 py-0.5 text-xs font-medium tracking-wide text-ink"
          >
            {observedBadgeLabel(snapshot.sources)}
          </span>
          <span className="text-xs text-muted" data-live-observed-counts="">
            {firestoreDocs} Firestore {firestoreDocs === 1 ? 'doc' : 'docs'} · {rtdbInstances} RTDB{' '}
            {rtdbInstances === 1 ? 'instance' : 'instances'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-live-export-seed=""
            disabled={!hasAnyObservedData}
            onClick={downloadSeedJson}
            className="rounded border border-line px-2.5 py-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export seed JSON
          </button>
          <button
            type="button"
            data-live-open-seed=""
            disabled={!hasAnyObservedData || seeding}
            onClick={() => {
              setConfirmOpen((open) => !open);
              setSeedError(null);
            }}
            className="rounded border border-line bg-elevated px-2.5 py-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Seed local sandbox…
          </button>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">
        Showing only documents and paths observed from this live session&apos;s reads and writes in
        host memory. Production is never queried directly, inline edits are refused, and nothing is
        written to <code>.pyric/</code> unless you explicitly seed your local sandbox.
      </p>

      {truncated ? (
        <p role="status" data-live-observed-truncated="" className="mt-1.5 text-xs text-muted">
          Session memory cap reached ({droppedCount} older{' '}
          {droppedCount === 1 ? 'entry' : 'entries'} evicted to bound host memory).
        </p>
      ) : null}

      {skipParts.length > 0 ? (
        <p role="status" data-live-observed-skips="" className="mt-1.5 text-xs text-muted">
          Not captured in Data: {skipParts.join(' · ')}.
        </p>
      ) : null}

      {observed.error ? (
        <p role="alert" data-live-observed-error="" className="mt-2 text-xs text-muted">
          Could not refresh observed session data: {observed.error}
        </p>
      ) : null}

      {confirmOpen ? (
        <div
          data-live-seed-confirm=""
          className="mt-3 rounded border border-line bg-elevated p-3 text-xs"
        >
          <p className="font-medium text-ink">Seed local sandbox from observed session data?</p>
          <p className="mt-1 leading-relaxed text-muted">
            This explicitly writes the currently observed {firestoreDocs} Firestore{' '}
            {firestoreDocs === 1 ? 'document' : 'documents'} and {rtdbInstances} RTDB{' '}
            {rtdbInstances === 1 ? 'instance' : 'instances'} to <code>.pyric/state/hosted</code>{' '}
            (and ensures <code>.pyric/</code> is listed in <code>.gitignore</code>) for offline use
            with <code>pyric sandbox</code>. Live mode stays read-only and never modifies
            production.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-ink">
              <input
                type="radio"
                name="pyric-live-seed-mode"
                value="merge"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
              />
              <span>Merge into local sandbox</span>
            </label>
            <label className="inline-flex items-center gap-1.5 text-ink">
              <input
                type="radio"
                name="pyric-live-seed-mode"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              />
              <span>Replace local sandbox data</span>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-live-confirm-seed=""
              disabled={seeding}
              onClick={() => void handleConfirmSeed()}
              className="rounded border border-line bg-panel px-3 py-1 font-medium text-ink disabled:opacity-50"
            >
              {seeding ? 'Seeding…' : 'Confirm seed'}
            </button>
            <button
              type="button"
              data-live-cancel-seed=""
              disabled={seeding}
              onClick={() => setConfirmOpen(false)}
              className="rounded px-2.5 py-1 text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {seedError ? (
        <p role="alert" data-live-seed-error="" className="mt-2 text-xs text-muted">
          Seed failed: {seedError}
        </p>
      ) : null}

      {seedResult ? (
        <p role="status" data-live-seed-result="" className="mt-2 text-xs text-muted">
          Seeded local sandbox ({seedResult.mode}): {seedResult.seededFirestoreDocs} Firestore{' '}
          {seedResult.seededFirestoreDocs === 1 ? 'document' : 'documents'}
          {seededRtdbClause(seedResult)}{' '}
          saved to <code>.pyric/state/hosted</code> for <code>pyric sandbox</code>.
        </p>
      ) : null}
    </div>
  );
}
