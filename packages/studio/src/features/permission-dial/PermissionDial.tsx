/**
 * Permission dial: the 2×2 governance control (F3).
 *
 * A header chip showing the active mode that opens a 2×2 grid:
 *
 *           sandbox            prod
 *        ┌──────────────┬──────────────┐
 *  review│ Sandbox·Rev  │ Prod·Review  │  ← caution (warning), locked
 *        ├──────────────┼──────────────┤
 *  no-rev│ Sandbox·NoRev│ Dangerous    │  ← danger, locked
 *        └──────────────┴──────────────┘
 *
 * Only the two sandbox cells are selectable. The prod column renders with the
 * reserved `--color-warning` / `--color-danger` roles but is `disabled` +
 * `aria-disabled` with a "prod gated off in v1" tooltip. Selecting a sandbox
 * cell maps to a confirm-policy descriptor (see `policy.ts` / `usePermissionDial`).
 *
 * Styling is token-role only (no raw hexes) so it themes with the shell.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { usePermissionDial, type UsePermissionDialOptions } from './usePermissionDial.js';
import { QUADRANTS, quadrant, type DialModeId, type QuadrantMeta } from './policy.js';

export interface PermissionDialProps extends UsePermissionDialOptions {}

/** Tone → token-role classes for a quadrant cell (border + accent text). */
function toneClasses(meta: QuadrantMeta, isSelected: boolean): string {
  if (meta.tone === 'danger') {
    // Dangerous prod: reserved danger styling, gated off.
    return 'border-danger/40 text-danger/70';
  }
  if (meta.tone === 'caution') {
    return 'border-warning/40 text-warning/70';
  }
  // Safe (sandbox).
  return isSelected
    ? 'border-primary bg-primary/10 text-soft-white'
    : 'border-border text-slate-gray hover:border-border-strong hover:text-soft-white';
}

function QuadrantCell({
  meta,
  isSelected,
  onSelect,
}: {
  meta: QuadrantMeta;
  isSelected: boolean;
  onSelect: (id: DialModeId) => void;
}) {
  const locked = !meta.selectable;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-disabled={locked || undefined}
      disabled={locked}
      title={locked ? meta.lockedReason : undefined}
      onClick={() => !locked && onSelect(meta.id)}
      className={[
        'relative flex h-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
        locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        toneClasses(meta, isSelected),
      ].join(' ')}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{meta.label}</span>
        {isSelected && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        {locked && (
          <span
            aria-hidden
            className="text-[0.6rem] uppercase tracking-wider opacity-80"
          >
            locked
          </span>
        )}
      </span>
      <span className="text-[0.7rem] leading-snug text-slate-gray">
        {meta.description}
      </span>
    </button>
  );
}

export function PermissionDial(props: PermissionDialProps) {
  const { selected, select } = usePermissionDial(props);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridId = useId();

  const current = quadrant(selected);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleSelect(id: DialModeId) {
    select(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={gridId}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-slate-gray transition-colors hover:border-border-strong hover:text-soft-white"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
        />
        <span>{current.label}</span>
        <span aria-hidden className="opacity-60">
          ▾
        </span>
      </button>

      {open && (
        <div
          id={gridId}
          role="radiogroup"
          aria-label="Permission mode"
          className="absolute right-0 top-full z-20 mt-2 w-[28rem] rounded-xl border border-border bg-sidebar-bg p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-soft-white">
              Permission mode
            </span>
            <span className="text-[0.65rem] uppercase tracking-wider text-slate-gray">
              autonomy × blast radius
            </span>
          </div>

          {/* Column headers: sandbox | prod */}
          <div className="mb-1 grid grid-cols-2 gap-2 px-1">
            <span className="text-[0.65rem] uppercase tracking-wider text-slate-gray">
              Sandbox
            </span>
            <span className="text-[0.65rem] uppercase tracking-wider text-slate-gray">
              Prod
            </span>
          </div>

          {/* The 2×2. QUADRANTS is row-major: [s:rev, p:rev, s:norev, p:norev]. */}
          <div className="grid grid-cols-2 grid-rows-2 gap-2">
            {QUADRANTS.map((meta) => (
              <QuadrantCell
                key={meta.id}
                meta={meta}
                isSelected={meta.id === selected}
                onSelect={handleSelect}
              />
            ))}
          </div>

          <p className="mt-3 px-1 text-[0.65rem] leading-snug text-slate-gray">
            Prod tier is gated off in v1. Selecting a sandbox mode changes the
            bridge confirm-policy (review = writes &amp; deploys pause).
          </p>
        </div>
      )}
    </div>
  );
}
