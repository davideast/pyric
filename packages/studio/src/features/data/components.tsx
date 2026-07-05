/**
 * Shared presentational atoms for the Data feature (F2): the lens toggle and
 * the clickable cross-reference value. Both reference semantic token roles only
 * (see `styles/tokens.css`) so they re-theme with the rest of Studio.
 */

import type { ReactNode } from 'react';
import { describeRef, detectRef, isCrossRef, type DetectRefOptions } from './refs.js';
import { applyWorkerLens, type DataLens } from './sandbox.js';
import { useDataNav } from './navigation.js';

/**
 * The access-mode toggle. Off = `app-session` (acting as the app; rules apply);
 * on = `admin` (full access; rules bypassed, "edit anything"). Admin is rendered
 * LOUD (danger role) because it skips security rules on purpose. Flipping it
 * swaps the Firestore handle the grids use AND mirrors the choice onto any
 * co-resident worker client (`setLens`). Plain terms, no "lens" jargon, no dot.
 */
export function LensToggle() {
  const { lens, setLens } = useDataNav();
  const admin = lens === 'admin';

  const toggle = () => {
    const next: DataLens = admin ? 'app-session' : 'admin';
    setLens(next);
    applyWorkerLens(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={admin}
      data-pyric-ui="lens-toggle"
      data-pyric-lens={lens}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        admin
          ? 'border-danger/50 bg-danger/10 text-danger'
          : 'border-border text-slate-gray hover:text-soft-white'
      }`}
      title={
        admin
          ? 'Admin access: security rules are OFF (edit anything). Click to act as the app.'
          : 'Acting as the app: security rules apply. Click for full admin access.'
      }
    >
      {admin ? 'Admin' : 'As app'}
    </button>
  );
}

export interface CrossRefValueProps {
  /** The raw field value to render. */
  value: unknown;
  /** The field key: sharpens uid/storage detection. */
  fieldKey?: string;
  /** Known Auth uids: makes user detection authoritative. */
  knownUids?: ReadonlySet<string>;
  /** Override the rendered label (defaults to the raw/derived string). */
  children?: ReactNode;
}

/**
 * Render a single field value, detecting whether it is a cross-service
 * reference. References render as a button that jumps to the target sub-view
 * (`useDataNav().navigateRef`); plain values render as inert text. The detected
 * kind is exposed via `data-pyric-ref` for styling + tests.
 */
export function CrossRefValue({ value, fieldKey, knownUids, children }: CrossRefValueProps) {
  const { navigateRef } = useDataNav();
  const options: DetectRefOptions = { fieldKey, knownUids };
  const ref = detectRef(value, options);
  const label = children ?? ref.raw;

  if (!isCrossRef(ref)) {
    return (
      <span data-pyric-ui="field-value" data-pyric-ref="plain" className="text-soft-white">
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigateRef(ref)}
      data-pyric-ui="field-value"
      data-pyric-ref={ref.kind}
      title={`Jump to ${describeRef(ref)}`}
      className="inline-flex items-center gap-1 rounded text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
    >
      {label}
      <span aria-hidden className="text-[0.7em] text-primary/70">
        ↗
      </span>
    </button>
  );
}
