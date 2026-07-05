import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function NumberDisplay({ value, path }: FieldDisplayProps<number>) {
  return (
    <span data-pyric-field-type="number" data-pyric-field-path={path}>
      {String(value)}
    </span>
  );
}

function NumberEdit({ value, onChange, error, path }: FieldEditProps<number>) {
  return (
    <label
      data-pyric-field-type="number"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <input
        type="number"
        // Render NaN as empty so the input doesn't show literally
        // "NaN" — the underlying value still carries it until the
        // user types something valid.
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const raw = e.target.value;
          // Empty input commits NaN so the reducer's validator
          // flags it; this keeps the editor's UI in sync with the
          // underlying value rather than swallowing the change.
          const parsed = raw === '' ? Number.NaN : parseFloat(raw);
          onChange(parsed);
        }}
        aria-invalid={error ? 'true' : undefined}
      />
      {error ? <span data-pyric-error-message>{error}</span> : null}
    </label>
  );
}

export const numberEditor: FieldEditorContract<number> = {
  type: 'number',
  Display: NumberDisplay,
  Edit: NumberEdit,
};
