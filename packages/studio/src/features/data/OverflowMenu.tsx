/**
 * Three-dot overflow menu (Console-parity): the collection column header's
 * "Delete collection" and the document panel header's "Delete document" /
 * "Delete document fields". Same hand-rolled pattern as `ai/ModelSelector.tsx`
 * (this repo has no headless-menu dependency): local open state, a trigger
 * button with `aria-haspopup`/`aria-expanded`, an absolutely-positioned
 * `role="menu"`, and a full-screen backdrop for outside-click dismissal.
 */

import { useEffect, useRef, useState } from 'react';

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  /** Styles the item as a destructive action (delete). */
  destructive?: boolean;
  disabled?: boolean;
}

export function OverflowMenu({
  items,
  label = 'More actions',
}: {
  items: OverflowMenuItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className="fs-overflow" data-pyric-ui="fs-overflow-menu">
      <button
        ref={triggerRef}
        type="button"
        className="fs-overflow__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <>
          <div className="fs-overflow__backdrop" onMouseDown={() => setOpen(false)} />
          <div className="fs-overflow__menu" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="fs-overflow__item"
                data-destructive={item.destructive ? '' : undefined}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}
