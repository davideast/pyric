import { useEffect, useRef, type RefObject } from 'react';

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

/** The elements inside `container` that Tab can reach, in document order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
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
 * The keyboard behavior the dialogs in this package share, on one window
 * listener while `open`: Escape calls `onClose`, and Tab and Shift+Tab stay
 * inside the element `containerRef` points at, cycling from the last
 * focusable element to the first and back.
 */
export function useDialogKeyboard(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const focused = document.activeElement;
      let currentIndex = focusables.indexOf(focused as HTMLElement);

      if (currentIndex === -1 && focused && container.contains(focused)) {
        const parentFocusable = (focused as HTMLElement).closest?.(FOCUSABLE_SELECTOR);
        if (parentFocusable) {
          currentIndex = focusables.indexOf(parentFocusable as HTMLElement);
        }
      }

      e.preventDefault();
      if (currentIndex === -1) {
        if (e.shiftKey) {
          last.focus();
        } else {
          first.focus();
        }
        return;
      }

      if (e.shiftKey) {
        if (currentIndex <= 0) {
          last.focus();
        } else {
          focusables[currentIndex - 1].focus();
        }
      } else if (currentIndex >= focusables.length - 1) {
        first.focus();
      } else {
        focusables[currentIndex + 1].focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, containerRef]);
}
