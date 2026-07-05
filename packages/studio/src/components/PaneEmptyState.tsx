/**
 * Pane empty state (T4).
 *
 * A styled wrapper over `@pyric/ui`'s headless `EmptyState`. Every pane renders
 * one of these until either (a) its Wave-2 feature lands or (b) the local
 * backend is wired (T3). Styling targets the `data-pyric-empty-*` hooks the
 * headless component emits, using token roles only.
 */

import { EmptyState } from '@pyric/ui/agents';
import type { ReactNode } from 'react';

export interface PaneEmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  /** Optional small kicker above the title (e.g. "Local backend pending"). */
  kicker?: ReactNode;
}

export function PaneEmptyState({ title, body, kicker }: PaneEmptyStateProps) {
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center text-center">
      {kicker ? (
        <p className="mb-3 rounded-full border border-border px-3 py-1 text-xs uppercase tracking-wide text-slate-gray">
          {kicker}
        </p>
      ) : null}
      <EmptyState
        title={title}
        body={body}
        // Style the headless structure via its data-* hooks + token roles.
        className={[
          'flex flex-col items-center',
          '[&_[data-pyric-empty-title]]:text-base [&_[data-pyric-empty-title]]:font-semibold [&_[data-pyric-empty-title]]:text-soft-white',
          '[&_[data-pyric-empty-body]]:mt-2 [&_[data-pyric-empty-body]]:max-w-md [&_[data-pyric-empty-body]]:text-sm [&_[data-pyric-empty-body]]:leading-relaxed [&_[data-pyric-empty-body]]:text-slate-gray',
        ].join(' ')}
      />
    </div>
  );
}
