import type { ReactNode } from 'react';
import type { ReplayDivergence } from '../replayTypes.js';

export interface ReplayDivergenceListProps {
  divergences: readonly ReplayDivergence[];
  selected?: ReplayDivergence | null;
  onSelect?: (divergence: ReplayDivergence) => void;
  className?: string;
  emptyState?: ReactNode;
}

function divergencePath(div: ReplayDivergence): string {
  if ('path' in div && div.path) return div.path;
  if ('originalPath' in div) return div.originalPath;
  return '';
}

function divergenceField(div: ReplayDivergence): string | undefined {
  if ('field' in div) return div.field;
  if ('method' in div) return div.method;
  return undefined;
}

/**
 * Headless list of replay divergences, with item attributes and kind classification
 * (`real-divergence`, `sentinel-drift`, `time-drift`, `autoid-alias`, `now-denied`).
 */
export function ReplayDivergenceList({
  divergences,
  selected,
  onSelect,
  className,
  emptyState = null,
}: ReplayDivergenceListProps) {
  if (divergences.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div className={className} data-pyric-ui="replay-divergence-list">
      <ul data-pyric-divergence-items="">
        {divergences.map((div, idx) => {
          const path = divergencePath(div);
          const field = divergenceField(div);
          const isSelected = selected === div;

          return (
            <li
              key={`${div.kind}-${path}-${field ?? idx}`}
              data-pyric-divergence-item=""
              data-pyric-divergence-kind={div.kind}
              data-pyric-selected={isSelected ? '' : undefined}
              onClick={() => onSelect?.(div)}
            >
              <span data-pyric-divergence-badge="">{div.kind}</span>
              <span data-pyric-divergence-path="">{path}</span>
              {field && <span data-pyric-divergence-field="">{field}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
