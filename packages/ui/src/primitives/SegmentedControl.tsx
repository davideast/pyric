import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  /** The value committed via `onChange` when this segment is picked. */
  value: T;
  /** Visible label. */
  label: ReactNode;
  /**
   * Freeform tone surfaced as `data-pyric-segment-tone` — e.g. `ok`
   * / `error` so the consumer can tint the active label. The library
   * doesn't enumerate tones.
   */
  tone?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** The selectable segments, rendered left-to-right. */
  options: ReadonlyArray<SegmentedOption<T>>;
  /** The currently-selected value. */
  value: T;
  /** Fired with the new value when a segment is clicked. */
  onChange: (value: T) => void;
  /** Forwarded to the container. */
  className?: string;
  /** Accessible label for the radiogroup. */
  ariaLabel?: string;
}

/**
 * Headless segmented control — a single-select group of pill
 * buttons that reads as one widget. Wired as an ARIA radiogroup.
 *
 * Ships no visual styling. Consumers style via:
 * - `[data-pyric-ui="segmented-control"]` — the container
 * - `[data-pyric-segment]` — each option button
 * - `[data-pyric-segment][data-pyric-active]` — the selected one
 * - `[data-pyric-segment-tone="…"]` — tone-tinted options
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      data-pyric-ui="segmented-control"
      className={className}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            data-pyric-segment=""
            data-pyric-active={active ? '' : undefined}
            data-pyric-segment-tone={opt.tone}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
