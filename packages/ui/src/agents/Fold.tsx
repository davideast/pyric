import type { ReactNode } from 'react';

export type FoldTone = 'normal' | 'error' | 'thought';

export interface FoldProps {
  /** Visible summary line, always rendered. */
  header: ReactNode;
  /** Optional right-aligned action (e.g. a copy button). Children
   *  should `stopPropagation` so clicks don't toggle the fold. */
  headerAction?: ReactNode;
  /** Revealed when the user expands. */
  children: ReactNode;
  defaultOpen?: boolean;
  /** Surfaced via `[data-pyric-fold-tone]` so consumers can tint the
   *  summary or border based on semantic context (error / thought).
   *  Defaults to `normal`. */
  tone?: FoldTone;
  /** Forwarded to the root `<details>` element. */
  className?: string;
  /** Forwarded to the `<summary>` element. */
  summaryClassName?: string;
  /** Forwarded to the body wrapper revealed when open. */
  bodyClassName?: string;
}

/**
 * Headless disclosure container — native `<details>` for keyboard /
 * a11y. Ships zero visual styling. Consumers style via the three
 * `className` slots or by selecting on:
 *
 *   [data-pyric-ui="fold"]             — root `<details>`
 *   [data-pyric-ui="fold"][open]       — expanded state
 *   [data-pyric-fold-tone="error"]     — error tint
 *   [data-pyric-fold-tone="thought"]   — thought-stream tint
 *   [data-pyric-fold-summary]          — clickable summary row
 *   [data-pyric-fold-chevron]          — disclosure indicator slot
 *   [data-pyric-fold-body]             — revealed body wrapper
 */
export function Fold({
  header,
  headerAction,
  children,
  defaultOpen = false,
  tone = 'normal',
  className,
  summaryClassName,
  bodyClassName,
}: FoldProps) {
  return (
    <details
      data-pyric-ui="fold"
      data-pyric-fold-tone={tone}
      open={defaultOpen}
      className={className}
    >
      <summary data-pyric-fold-summary className={summaryClassName}>
        <span data-pyric-fold-chevron aria-hidden="true" />
        <span data-pyric-fold-header>{header}</span>
        {headerAction ? <span data-pyric-fold-action>{headerAction}</span> : null}
      </summary>
      <div data-pyric-fold-body className={bodyClassName}>{children}</div>
    </details>
  );
}
