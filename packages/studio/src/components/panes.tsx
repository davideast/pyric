/**
 * Service panes (T4): the actual `@pyric/ui` surfaces mounted in their empty
 * state.
 *
 * Every `@pyric/ui` list surface is pure-props: it accepts a data array plus an
 * `emptyState` slot and needs no live handle to render. T4 mounts each surface
 * NOW with an empty data array and a styled empty state, so the real components
 * are on screen and styled against the token contract. Wave 2 (F2 et al.) swaps
 * the empty arrays for live data once T3's local backend resolves the env; the
 * mount point and styling are already in place.
 *
 * The styled `emptyState` copy is backend-aware: when the env hasn't resolved
 * (T3 not landed), it says so; once `ready`, it's the ordinary "nothing here
 * yet" state.
 */

import type { ReactNode } from 'react';
import { TrafficLog } from '@pyric/ui/traffic';
import { useEnvironment, type EnvironmentStatus } from '../shell/environment.js';
// F2: the Data tabs (Firestore/Auth/Storage) render the live cross-service
// viewer/editor feature, which reuses the `@pyric/ui` grids internally and
// wires the admin lens + clickable cross-references.
import { DataFeature } from '../features/data/DataFeature.js';

/** Shared styling for a surface's inline empty state (token roles only). */
function SurfaceEmpty({
  status,
  ready,
  pending,
}: {
  status: EnvironmentStatus;
  /** Copy shown when the backend is live but the surface has no data. */
  ready: ReactNode;
  /** Copy shown while the local backend isn't resolved (T3 pending). */
  pending: ReactNode;
}) {
  const backendLive = status === 'ready';
  return (
    <div
      data-pyric-ui="surface-empty"
      className="flex flex-col items-center justify-center gap-2 py-16 text-center"
    >
      {!backendLive ? (
        <span className="rounded-full border border-border px-3 py-1 text-xs uppercase tracking-wide text-slate-gray">
          Local backend pending
        </span>
      ) : null}
      <p className="max-w-md text-sm leading-relaxed text-slate-gray">
        {backendLive ? ready : pending}
      </p>
    </div>
  );
}

/** Common Tailwind hooks so the headless list rows read against the tokens. */
const LIST_CLASS =
  'block w-full text-sm text-soft-white [&_button]:text-left [&_[data-pyric-selected]]:text-primary';

// ── Data tabs (F2) ──────────────────────────────────────────────────────────
// Firestore / Auth / Storage all render the one cross-service Data feature,
// scoped to the requested service sub-view. The feature mounts the `@pyric/ui`
// grids live (admin lens, clickable cross-refs) when the local backend is
// reachable, and falls back to a backend-aware empty state otherwise.
// The shell's `.studio__content` frame supplies width (1120) + full height; the
// pane is just the feature. (The NL-seed AI box that used to sit on top is gone:
// the AI gets re-woven as a flow, not a strip bolted above the browser.)
export function FirestorePane() {
  return <DataFeature view="firestore" />;
}

export function AuthPane() {
  return <DataFeature view="auth" />;
}

export function StoragePane() {
  return <DataFeature view="storage" />;
}

export function TrafficPane() {
  const { status } = useEnvironment();
  return (
    <div className="mx-auto h-full w-full max-w-4xl">
      <TrafficLog
        events={[]}
        className={`${LIST_CLASS} font-mono`}
        emptyState={
          <SurfaceEmpty
            status={status}
            ready="No requests yet. Reads, writes, and listeners against the sandbox stream in live."
            pending="The traffic log mounts here. Requests stream in once the local sandbox backend is reachable (T3)."
          />
        }
      />
    </div>
  );
}
