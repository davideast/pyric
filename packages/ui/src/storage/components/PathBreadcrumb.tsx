import type { ReactNode } from 'react';
import { normalizeStoragePath } from '../hooks/usePathState.js';

export interface PathBreadcrumbProps {
  /** Current path. `''` renders just the root crumb. */
  path: string;
  /** Fired with the absolute path of the clicked crumb (`''` for
   *  root). Wire to `usePathState.setPath`. */
  onNavigate?: (path: string) => void;
  /** Label for the root crumb. Default `'/'` — pass the bucket name
   *  for a `gs://bucket` feel. */
  rootLabel?: ReactNode;
  /** Rendered between crumbs. Default `'/'`. */
  separator?: ReactNode;
  className?: string;
}

/**
 * Headless breadcrumb for storage paths. Every crumb (including the
 * current one) is a real `<button>` — clicking the current crumb is
 * a cheap "refresh this level" affordance for consumers that wire
 * `onNavigate` to a path-keyed loader.
 *
 * Ships no visual styling. Consumers style via:
 * - `[data-pyric-ui="path-breadcrumb"]` — the `<nav>` root
 * - `[data-pyric-breadcrumb-item]` — each `<li>`
 * - `[data-pyric-breadcrumb-link]` — each crumb button
 * - `[data-pyric-breadcrumb-link][data-pyric-current]` — the current level
 * - `[data-pyric-breadcrumb-root]` — the root crumb's button
 * - `[data-pyric-breadcrumb-separator]` — the separators
 */
export function PathBreadcrumb({
  path,
  onNavigate,
  rootLabel = '/',
  separator = '/',
  className,
}: PathBreadcrumbProps) {
  const normalized = normalizeStoragePath(path);
  const segments = normalized === '' ? [] : normalized.split('/');

  return (
    <nav
      className={className}
      data-pyric-ui="path-breadcrumb"
      aria-label="Storage path"
    >
      <ol data-pyric-breadcrumb-list>
        <li data-pyric-breadcrumb-item>
          <button
            type="button"
            onClick={() => onNavigate?.('')}
            data-pyric-breadcrumb-link
            data-pyric-breadcrumb-root
            data-pyric-current={segments.length === 0 ? '' : undefined}
            aria-current={segments.length === 0 ? 'page' : undefined}
          >
            {rootLabel}
          </button>
        </li>
        {segments.map((segment, i) => {
          const isCurrent = i === segments.length - 1;
          const target = segments.slice(0, i + 1).join('/');
          return (
            <li key={target} data-pyric-breadcrumb-item>
              <span aria-hidden data-pyric-breadcrumb-separator>
                {separator}
              </span>
              <button
                type="button"
                onClick={() => onNavigate?.(target)}
                data-pyric-breadcrumb-link
                data-pyric-current={isCurrent ? '' : undefined}
                aria-current={isCurrent ? 'page' : undefined}
              >
                {segment}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
