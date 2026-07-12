/**
 * TopBar autosave indicator — "Autosave on / Saving… / Saved · just
 * now / Save failed", driven by the real save lifecycle reported into
 * `useAutosaveStore` by `useSessionRouting` (no fake timers; the only
 * timer here re-renders the relative-time label).
 *
 * Clicking it opens a small popover with the persistence truth copy
 * (`AUTOSAVE_TRUTH_COPY`).
 */
import { useEffect, useRef, useState } from 'react';
import {
  AUTOSAVE_TRUTH_COPY,
  describeAutosave,
  useAutosaveStore,
  type AutosaveState,
} from '~/lib/store/autosave';

const TONE_CLASSES: Record<string, string> = {
  muted: 'text-slate-gray',
  busy: 'text-slate-gray',
  ok: 'text-slate-gray',
  error: 'text-[#f0a0a0]',
};

const TONE_ICONS: Record<string, string> = {
  muted: 'cloud',
  busy: 'sync',
  ok: 'cloud_done',
  error: 'error',
};

export interface AutosaveStatusProps {}

export function AutosaveStatus(_: AutosaveStatusProps) {
  const state = useAutosaveStore((s) => s.state);
  return <AutosaveStatusView state={state} />;
}

export interface AutosaveStatusViewProps extends AutosaveStatusProps {
  state: AutosaveState;
}

/** Presentational half — state in via props so render states are
 *  testable with `renderToString` (the store hook resolves to its
 *  initial state under SSR). */
export function AutosaveStatusView({ state }: AutosaveStatusViewProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Tick the relative-time label while showing a "Saved · …" state.
  // This re-renders the DERIVED label only; the underlying status
  // never changes here.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state.status !== 'saved') return;
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [state.status]);

  // Light-dismiss: outside click or Escape closes the popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const desc = describeAutosave(state);
  const detail =
    state.status === 'error' ? `${AUTOSAVE_TRUTH_COPY}\n\n${state.message}` : AUTOSAVE_TRUTH_COPY;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={detail}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={[
          'flex items-center gap-1.5 px-2 py-1.5 rounded transition-colors',
          'hover:text-soft-white',
          TONE_CLASSES[desc.tone] ?? 'text-slate-gray',
        ].join(' ')}
      >
        <span
          className={[
            'material-symbols-outlined text-[16px]',
            desc.tone === 'busy' ? 'animate-spin' : '',
          ].join(' ')}
          aria-hidden
        >
          {TONE_ICONS[desc.tone] ?? 'cloud_done'}
        </span>
        {/* The label is the indicator; keep it visible from sm: up and
            icon-only on the tightest mobile bar. */}
        <span className="hidden sm:inline text-[11px] font-mono whitespace-nowrap">
          {desc.label}
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Autosave details"
          className={[
            'absolute right-0 top-full mt-2 w-72 z-50 rounded-md p-3.5',
            'bg-[#0f0f17] border border-[#2a2a35] shadow-xl space-y-3',
          ].join(' ')}
        >
          <div className="text-[11px] font-mono uppercase tracking-wider text-slate-gray">
            {desc.label}
          </div>
          <p className="text-[12px] text-soft-white/80 leading-relaxed">
            {AUTOSAVE_TRUTH_COPY}
          </p>
          {state.status === 'error' ? (
            <p className="text-[11px] font-mono text-[#f0a0a0] break-words">
              {state.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
