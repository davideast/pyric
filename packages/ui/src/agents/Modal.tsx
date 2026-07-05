import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
  /** Forwarded to the root wrapper (covers the full viewport). */
  className?: string;
  /** Forwarded to the backdrop element. */
  backdropClassName?: string;
  /** Forwarded to the inner panel. */
  panelClassName?: string;
}

/**
 * Headless modal — provides behavior only (Escape-to-close, backdrop
 * click, `aria-modal`). Consumers attach all visual styling via the
 * three `className` slots or by selecting on the emitted data
 * attributes:
 *
 *   [data-pyric-ui="modal"]            — root viewport wrapper
 *   [data-pyric-modal-backdrop]        — clickable backdrop
 *   [data-pyric-modal-panel]           — inner panel containing children
 */
export function Modal({
  open,
  onClose,
  children,
  ariaLabel,
  className,
  backdropClassName,
  panelClassName,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-pyric-ui="modal"
      className={className}
    >
      <div
        data-pyric-modal-backdrop
        className={backdropClassName}
        onClick={onClose}
        aria-hidden="true"
      />
      <div data-pyric-modal-panel className={panelClassName}>
        {children}
      </div>
    </div>
  );
}
