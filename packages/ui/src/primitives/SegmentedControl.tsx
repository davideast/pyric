import { useRef, type KeyboardEvent, type ReactNode } from 'react';

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
 * buttons that reads as one widget. Wired as an ARIA radiogroup: one
 * segment is in the tab order, the selected one or else the first, and
 * the arrow keys, Home and End move the selection and focus, wrapping at
 * the ends.
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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const tabStopIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const moveTo = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % count;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + count) % count;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = count - 1;
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div
      data-pyric-ui="segmented-control"
      className={className}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt, index) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
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
