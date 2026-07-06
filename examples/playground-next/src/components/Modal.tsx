/**
 * Minimal centered modal. Close on backdrop click or Escape.
 */
import { useEffect } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
}

export function Modal({ open, onClose, children, ariaLabel }: ModalProps) {
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
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Mobile: bottom sheet (full-width, rounded top corners, slides
       *   up from the bottom — native idiom, plays well with the
       *   soft keyboard).
       * Desktop: centered modal, capped width.
       */}
      <div
        className={[
          'relative z-10 bg-sidebar-bg border border-[#2a2a35] shadow-2xl',
          'overflow-y-auto custom-scrollbar',
          'w-full md:w-[92%] md:max-w-[560px]',
          'rounded-t-2xl md:rounded-lg',
          'max-h-[88dvh] md:max-h-[88vh]',
          'p-6 md:p-8',
        ].join(' ')}
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </div>
    </div>
  );
}
