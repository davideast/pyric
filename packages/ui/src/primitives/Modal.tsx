import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

export interface ModalProps {
  /** Controlled open state. */
  open: boolean;
  /** Called when the user dismisses via backdrop click or Escape. */
  onClose: () => void;
  /** Content rendered inside the inner panel. */
  children: ReactNode;
  /** Accessible name for the dialog. */
  ariaLabel?: string;
  /** Accessible label element ID. */
  ariaLabelledBy?: string;
  /** Accessible description element ID. */
  ariaDescribedBy?: string;
  /** Optional ref to focus when the modal opens. Defaults to first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Forwarded to the root wrapper (covers the full viewport). */
  className?: string;
  /** Forwarded to the backdrop element. */
  backdropClassName?: string;
  /** Forwarded to the inner panel. */
  panelClassName?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex^="-"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if ((el as any).disabled) return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.tabIndex < 0) return false;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      } catch {
        // Safe fallback in test environments
      }
    }
    return true;
  });
}

/**
 * Headless modal primitive — provides accessible behavior:
 * - Traps keyboard focus within panel (`Tab` and `Shift+Tab` cycling)
 * - Restores focus to original trigger element on close
 * - Dismisses on `Escape` key or backdrop click
 * - Emits ARIA dialog attributes (`role="dialog"`, `aria-modal="true"`)
 *
 * Ships zero visual styling. Consumers attach styles via `className` slots
 * or by targeting emitted attributes:
 *   [data-pyric-ui="modal"]      — root viewport wrapper
 *   [data-pyric-modal-backdrop]  — clickable backdrop
 *   [data-pyric-modal-panel]     — inner panel containing children
 */
export function Modal({
  open,
  onClose,
  children,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  initialFocusRef,
  className,
  backdropClassName,
  panelClassName,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRefProp = useRef(initialFocusRef);
  initialFocusRefProp.current = initialFocusRef;

  // Focus management: capture activeElement on open, set initial focus,
  // and restore focus to trigger element on close / unmount.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;

    const panel = panelRef.current;
    if (panel) {
      const preferred = initialFocusRefProp.current?.current;
      if (preferred && typeof preferred.focus === 'function') {
        preferred.focus();
      } else {
        const focusables = getFocusableElements(panel);
        if (focusables.length > 0) {
          focusables[0].focus();
        } else {
          panel.focus();
        }
      }
    }

    return () => {
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function' && prev.isConnected !== false) {
        prev.focus();
        queueMicrotask(() => {
          if (document.activeElement !== prev && typeof prev.focus === 'function' && prev.isConnected !== false) {
            prev.focus();
          }
        });
      }
    };
  }, [open]);

  // Keyboard navigation: Escape-to-close and Tab/Shift+Tab focus cycling
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;

        const focusables = getFocusableElements(panel);
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        let currentIndex = focusables.indexOf(active as HTMLElement);

        if (currentIndex === -1 && active && panel.contains(active)) {
          const parentFocusable = (active as HTMLElement).closest?.(FOCUSABLE_SELECTOR);
          if (parentFocusable) {
            currentIndex = focusables.indexOf(parentFocusable as HTMLElement);
          }
        }

        if (currentIndex === -1) {
          e.preventDefault();
          if (e.shiftKey) {
            last.focus();
          } else {
            first.focus();
          }
          return;
        }

        if (e.shiftKey) {
          // Shift + Tab (backward)
          e.preventDefault();
          if (currentIndex <= 0) {
            last.focus();
          } else {
            focusables[currentIndex - 1].focus();
          }
        } else {
          // Tab (forward)
          e.preventDefault();
          if (currentIndex >= focusables.length - 1) {
            first.focus();
          } else {
            focusables[currentIndex + 1].focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      data-pyric-ui="modal"
      className={className}
    >
      <div
        data-pyric-modal-backdrop
        className={backdropClassName}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        data-pyric-modal-panel
        className={panelClassName}
      >
        {children}
      </div>
    </div>
  );
}
