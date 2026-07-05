import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function StringDisplay({ value, path }: FieldDisplayProps<string>) {
  return (
    <span data-pyric-field-type="string" data-pyric-field-path={path}>
      {value}
    </span>
  );
}

function StringEdit({ value, onChange, error, path }: FieldEditProps<string>) {
  return (
    <label
      data-pyric-field-type="string"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
      />
      {error ? <span data-pyric-error-message>{error}</span> : null}
    </label>
  );
}

export const stringEditor: FieldEditorContract<string> = {
  type: 'string',
  Display: StringDisplay,
  Edit: StringEdit,
};
