import { Timestamp } from 'pyric/firestore';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

/**
 * Coerce a Timestamp value to a Date. Real instances use `.toDate()`; a value
 * that crossed a worker / postMessage boundary arrives as a plain
 * `{ seconds, nanoseconds }` (or `{ _seconds, _nanoseconds }`) and is rebuilt
 * here, so the display + editor work in both in-process and served modes.
 */
function coerceDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  const o = value as Record<string, number> | null;
  const seconds = o ? (o.seconds ?? o._seconds) : undefined;
  const nanoseconds = o ? (o.nanoseconds ?? o._nanoseconds ?? 0) : 0;
  if (typeof seconds === 'number') return new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6));
  return new Date(NaN);
}

/** Rebuild a Timestamp from a serialized `{ seconds, nanoseconds }` value. */
function toTimestamp(value: unknown): Timestamp {
  const o = value as Record<string, number>;
  return new Timestamp(o.seconds ?? o._seconds ?? 0, o.nanoseconds ?? o._nanoseconds ?? 0);
}

/**
 * Convert the input's local `YYYY-MM-DDTHH:MM[:SS[.mmm]]` string to a
 * Timestamp. When the edit leaves the millisecond unchanged, the original
 * value is returned so its sub-millisecond nanoseconds survive.
 */
export function timestampFromInput(next: string, original: unknown): Timestamp | null {
  const edited = new Date(next);
  if (Number.isNaN(edited.getTime())) return null;
  const before = coerceDate(original);
  if (!Number.isNaN(before.getTime()) && before.getTime() === edited.getTime()) {
    return original instanceof Timestamp ? original : toTimestamp(original);
  }
  return Timestamp.fromDate(edited);
}

function TimestampDisplay({ value, path }: FieldDisplayProps<Timestamp>) {
  const date = coerceDate(value);
  const iso = Number.isNaN(date.getTime()) ? '' : date.toISOString();
  return (
    <time
      dateTime={iso}
      data-pyric-field-type="timestamp"
      data-pyric-field-path={path}
    >
      {iso}
    </time>
  );
}

/**
 * Native `<input type="datetime-local">` for editing. The element
 * speaks local time (no zone offset); we convert to/from a UTC
 * `Timestamp` at the boundary so the underlying value stays
 * timezone-correct.
 */
function TimestampEdit({ value, onChange, error, path }: FieldEditProps<Timestamp>) {
  // The native input speaks `YYYY-MM-DDTHH:MM:SS.mmm`; `step="0.001"` keeps
  // seconds and milliseconds editable. Sub-millisecond nanoseconds cannot be
  // shown, so an edit that leaves the millisecond unchanged returns the
  // original value untouched.
  const dt = coerceDate(value);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60_000);
  const inputValue = Number.isNaN(local.getTime()) ? '' : local.toISOString().slice(0, 23);

  return (
    <label
      data-pyric-field-type="timestamp"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <input
        type="datetime-local"
        step="0.001"
        value={inputValue}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) return;
          const edited = timestampFromInput(next, value);
          if (edited) onChange(edited);
        }}
        aria-invalid={error ? 'true' : undefined}
      />
      {error ? <span data-pyric-error-message>{error}</span> : null}
    </label>
  );
}

export const timestampEditor: FieldEditorContract<Timestamp> = {
  type: 'timestamp',
  Display: TimestampDisplay,
  Edit: TimestampEdit,
};
