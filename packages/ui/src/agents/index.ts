/**
 * `@pyric/ui/agents` — headless structural components for agentic UIs
 * (chat surfaces, tool-call drill-ins, streaming state indicators).
 *
 * Matches the rest of `@pyric/ui`: zero shipped CSS. Components emit
 * `data-pyric-*` attributes and accept `className` slots. Consumers
 * bring their own design system (Tailwind, CSS modules, plain CSS)
 * and attach styling via attribute selectors or class names.
 */

export { Fold, type FoldProps, type FoldTone } from './Fold.js';
export { Modal, type ModalProps } from './Modal.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';
export { PulsingDot, type PulsingDotProps } from './PulsingDot.js';
export {
  ContextWindowMeter,
  ContextWindowPanel,
  ContextWindowRing,
  RequestUsageTimeline,
  SessionSpendSummary,
  TokenUsageInline,
  type ContextWindowMeterProps,
  type ContextWindowPanelProps,
  type ContextWindowRingProps,
  type RequestUsageTimelineProps,
  type SessionSpendSummaryProps,
  type TokenUsageInlineProps,
} from './ContextWindowUsage.js';
