/**
 * Small foldable container used inside Activity turns. Native
 * `<details>` for keyboard / a11y; custom chrome for visual fit.
 * One line summary (the `header` slot) on top, body content reveals
 * underneath when expanded. The disclosure chevron rotates on open.
 *
 * Default collapsed — turn cards are dense and the user opens what
 * they want to inspect. Pass `defaultOpen` to override for the
 * streaming thinking case where the user might want to watch live.
 */
import type { ReactNode } from 'react';

export interface FoldProps {
  /** Visible summary line, always rendered. */
  header: ReactNode;
  /** Optional right-aligned action (e.g. a copy button). Rendered
   *  inside the summary, but children should `stopPropagation` so
   *  click doesn't toggle the fold. `CopyButton` already does. */
  headerAction?: ReactNode;
  /** Revealed when the user expands. */
  children: ReactNode;
  defaultOpen?: boolean;
  /** Slight tint applied when the fold represents an error/denial. */
  tone?: 'normal' | 'error' | 'thought';
}

export function Fold({ header, headerAction, children, defaultOpen = false, tone = 'normal' }: FoldProps) {
  const summaryTone =
    tone === 'error'
      ? 'text-[#f0a0a0]'
      : tone === 'thought'
        ? 'text-slate-gray italic'
        : 'text-soft-white';
  return (
    <details
      open={defaultOpen}
      className="group rounded-md border border-[#2a2a35] bg-[#1a1a22]/40 overflow-hidden"
    >
      <summary
        className={[
          'flex items-center gap-2 px-3 py-2 cursor-pointer select-none',
          'hover:bg-[#2a2a35]/30 transition-colors text-[12px]',
          'list-none [&::-webkit-details-marker]:hidden',
          summaryTone,
        ].join(' ')}
      >
        <span className="material-symbols-outlined text-[16px] text-slate-gray transition-transform group-open:rotate-90">
          chevron_right
        </span>
        <span className="flex-1 min-w-0 truncate">{header}</span>
        {headerAction ? <span className="shrink-0">{headerAction}</span> : null}
      </summary>
      <div className="px-3 pb-3 pt-1 border-t border-[#2a2a35]/60">{children}</div>
    </details>
  );
}
