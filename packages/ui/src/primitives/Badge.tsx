import type { ReactNode } from 'react';

export interface BadgeProps {
  /** Badge content — usually a short word like "ALLOW" or "GET". */
  children: ReactNode;
  /**
   * Freeform category surfaced as `data-pyric-badge-kind`. The
   * library doesn't enumerate kinds — the consumer decides what
   * values exist (`allow`, `deny`, `get`, `update`, …) and styles
   * them via `[data-pyric-badge-kind="…"]`.
   */
  kind?: string;
  /** Forwarded to the underlying `<span>`. */
  className?: string;
  /**
   * Accessible label. When set, the visible text becomes
   * `aria-hidden` and screen readers announce this instead — useful
   * when the badge is a terse glyph but the meaning is longer.
   */
  ariaLabel?: string;
}

/**
 * Headless pill / tag. Renders an inline `<span>` carrying
 * `data-pyric-badge` and (when `kind` is set) `data-pyric-badge-kind`
 * so consumers can style categories with attribute selectors. Ships
 * no visual styling of its own.
 */
export function Badge({ children, kind, className, ariaLabel }: BadgeProps) {
  return (
    <span
      data-pyric-badge=""
      data-pyric-badge-kind={kind}
      className={className}
      aria-label={ariaLabel}
    >
      {ariaLabel ? <span aria-hidden="true">{children}</span> : children}
    </span>
  );
}
