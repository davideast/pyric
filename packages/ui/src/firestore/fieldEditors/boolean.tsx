import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function BooleanDisplay({ value, path }: FieldDisplayProps<boolean>) {
  return (
    <span
      data-pyric-field-type="boolean"
      data-pyric-field-path={path}
      data-value={value ? 'true' : 'false'}
    >
      {value ? 'true' : 'false'}
    </span>
  );
}

function BooleanEdit({ value, onChange, path }: FieldEditProps<boolean>) {
  return (
    <span
      data-pyric-field-type="boolean"
      data-pyric-field-path={path}
      data-value={value ? 'true' : 'false'}
    >
      <select
        value={value ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        aria-label="Boolean value"
        data-pyric-boolean-select
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    </span>
  );
}

export const booleanEditor: FieldEditorContract<boolean> = {
  type: 'boolean',
  Display: BooleanDisplay,
  Edit: BooleanEdit,
};
