import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** Optional pre-rendered icon node — consumers pass whatever icon
   *  primitive their app uses (Material Symbols span, lucide-react
   *  component, plain SVG, …). */
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  className?: string;
}

/**
 * Headless zero-state. Structural only: icon slot, title, optional
 * body, all wrapped in a flex container marked
 * `[data-pyric-ui="empty-state"]`. Consumers attach all visual
 * styling.
 */
export function EmptyState({ icon, title, body, className }: EmptyStateProps) {
  return (
    <div data-pyric-ui="empty-state" className={className}>
      {icon ? <span data-pyric-empty-icon>{icon}</span> : null}
      <p data-pyric-empty-title>{title}</p>
      {body ? <p data-pyric-empty-body>{body}</p> : null}
    </div>
  );
}
