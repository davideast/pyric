import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Called when the user dismisses via overlay click, Escape, or
   *  the cancel button. NOT called by `onConfirm`. */
  onOpenChange: (open: boolean) => void;
  /** Heading. */
  title: string;
  /** Body content — explanation, consequences, paths affected. */
  body?: ReactNode;
  /** When `true`, the confirm button carries `data-pyric-destructive`
   *  so consumers can style it differently (e.g. red). */
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Fires when the user presses confirm. The component does NOT
   *  close itself on confirm — the consumer typically dismisses
   *  after the destructive action resolves. */
  onConfirm: () => void;
  /** Forwarded to the content node so consumers can style. */
  className?: string;
}

/**
 * Headless confirmation dialog. Hand-rolled (we evaluated Radix
 * Dialog at M4 but Radix's Presence + Portal stack doesn't render
 * under our bun:test + JSDOM env — see plan section 7 risk #1).
 *
 * Provides:
 *   - Portal to `document.body` (so the dialog can escape parent
 *     stacking contexts)
 *   - Escape-to-close
 *   - Overlay click to close
 *   - ARIA `role="dialog" aria-modal="true"` wiring
 *   - Focus restoration to the previously-focused element on close
 *   - Initial focus on the confirm button when opening
 *
 * Ships no visual CSS. Consumers style via the structural
 * `data-pyric-*` attributes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  destructive,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  className,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  // Focus management: capture the previously-focused element on
  // open, restore it on close. Initial focus goes to the confirm
  // button so destructive actions don't dispatch by accident
  // (consumers wanting "Cancel" as the default can refocus in an
  // effect).
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    confirmButtonRef.current?.focus();
    return () => {
      const prev = previouslyFocused.current as HTMLElement | null;
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="presentation"
      data-pyric-ui="confirm-portal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div data-pyric-ui="confirm-overlay" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pyric-confirm-title"
        aria-describedby={body ? 'pyric-confirm-body' : undefined}
        className={className}
        data-pyric-ui="confirm-dialog"
        data-pyric-destructive={destructive ? '' : undefined}
      >
        <div id="pyric-confirm-title" data-pyric-confirm-title>
          {title}
        </div>
        {body ? (
          <div id="pyric-confirm-body" data-pyric-confirm-body>
            {body}
          </div>
        ) : null}
        <div data-pyric-confirm-actions>
          <button
            type="button"
            data-pyric-confirm-cancel
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            data-pyric-confirm-confirm
            data-pyric-destructive={destructive ? '' : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
