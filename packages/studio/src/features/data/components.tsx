/**
 * Shared presentational atoms for the Data feature (F2): the clickable
 * cross-reference value. References semantic token roles only (see
 * `styles/tokens.css`) so it re-themes with the rest of Studio.
 *
 * (The former LensToggle is gone: Studio data views are ALWAYS admin —
 * PRINCIPLES M2/M3. "What can user X see" is a simulation in the rules
 * debugger, never a viewing mode.)
 */

import type { ReactNode } from 'react';
import { describeRef, detectRef, isCrossRef, type DetectRefOptions } from './refs.js';
import { useDataNav } from './navigation.js';

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
