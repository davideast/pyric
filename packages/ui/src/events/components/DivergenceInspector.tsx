import type { ReactNode } from 'react';
import type { ReplayDivergence } from '../replayTypes.js';

export interface DivergenceInspectorProps {
  divergence?: ReplayDivergence | null;
  className?: string;
  emptyState?: ReactNode;
  onClose?: () => void;
}

function formatVal(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Headless inspector displaying a single classified divergence, detailing
 * state differences, sentinel metadata for `sentinel-drift`, or denial reasons
 * for `now-denied`.
 */
export function DivergenceInspector({
  divergence,
  className,
  emptyState = null,
  onClose,
}: DivergenceInspectorProps) {
  if (!divergence) {
    return <>{emptyState}</>;
  }

  const path =
    'path' in divergence
      ? divergence.path
      : 'originalPath' in divergence
        ? divergence.originalPath
        : undefined;

  const field = 'field' in divergence ? divergence.field : undefined;

  return (
    <div className={className} data-pyric-ui="divergence-inspector">
      <header data-pyric-divergence-head="">
        <span data-pyric-divergence-kind={divergence.kind}>
          {divergence.kind}
        </span>
        {path && <span data-pyric-divergence-path="">{path}</span>}
        {field && <span data-pyric-divergence-field="">{field}</span>}
        {onClose && (
          <button type="button" onClick={onClose} data-pyric-inspector-close="">
            Close
          </button>
        )}
      </header>

      <div data-pyric-divergence-details="">
        {divergence.kind === 'sentinel-drift' && (
          <div data-pyric-sentinel-drift-info="">
            <span data-pyric-sentinel-kind="">
              {divergence.sentinelKind}
            </span>
            <div data-pyric-diff-before="">
              <label>Captured value</label>
              <pre>{formatVal(divergence.before)}</pre>
            </div>
            <div data-pyric-diff-after="">
              <label>Replayed value</label>
              <pre>{formatVal(divergence.after)}</pre>
            </div>
          </div>
        )}

        {divergence.kind === 'now-denied' && (
          <div data-pyric-now-denied-info="">
            {divergence.method && (
              <span data-pyric-denial-method="">{divergence.method}</span>
            )}
            {divergence.reason && (
              <span data-pyric-denial-reason="">{divergence.reason}</span>
            )}
          </div>
        )}

        {divergence.kind === 'autoid-alias' && (
          <div data-pyric-autoid-alias-info="">
            <span data-pyric-alias-original="">{divergence.originalPath}</span>
            <span data-pyric-alias-replayed="">{divergence.replayedPath}</span>
          </div>
        )}

        {divergence.kind === 'time-drift' && (
          <div data-pyric-time-drift-info="">
            <div data-pyric-diff-before="">
              <label>Captured time</label>
              <pre>{formatVal(divergence.before)}</pre>
            </div>
            <div data-pyric-diff-after="">
              <label>Replayed time</label>
              <pre>{formatVal(divergence.after)}</pre>
            </div>
          </div>
        )}

        {divergence.kind === 'real-divergence' && (
          <div data-pyric-real-divergence-info="">
            <div data-pyric-diff-before="">
              <label>Original</label>
              <pre>{formatVal(divergence.before)}</pre>
            </div>
            <div data-pyric-diff-after="">
              <label>Replayed</label>
              <pre>{formatVal(divergence.after)}</pre>
            </div>
          </div>
        )}

        {divergence.kind === 'state-drift' && (
          <div data-pyric-state-drift-info="">
            <div data-pyric-diff-before="">
              <label>Before</label>
              <pre>{formatVal(divergence.before)}</pre>
            </div>
            <div data-pyric-diff-after="">
              <label>After</label>
              <pre>{formatVal(divergence.after)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
