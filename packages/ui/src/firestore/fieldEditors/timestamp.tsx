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
  // Convert the value to the `YYYY-MM-DDTHH:MM` shape <input
  // datetime-local> wants. Seconds and millis aren't part of the
  // native input precision; round-trips through this editor lose
  // sub-minute resolution intentionally — consumers needing higher
  // fidelity should swap the editor out via the registry.
  const dt = coerceDate(value);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60_000);
  const inputValue = Number.isNaN(local.getTime()) ? '' : local.toISOString().slice(0, 16);

  return (
    <label
      data-pyric-field-type="timestamp"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <input
        type="datetime-local"
        value={inputValue}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) return;
          const localDate = new Date(next);
          onChange(Timestamp.fromDate(localDate));
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
