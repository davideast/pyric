import { useFormControl } from '../../primitives/FormControl.js';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function StringDisplay({ value, path }: FieldDisplayProps<string>) {
  return (
    <span data-pyric-field-type="string" data-pyric-field-path={path}>
      {value}
    </span>
  );
}

function StringEdit({ value, onChange, error, path }: FieldEditProps<string>) {
  const formControl = useFormControl({ error });
  return (
    <span
      data-pyric-field-type="string"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <label>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={formControl.describedBy}
          aria-label="String value"
        />
      </label>
      {error ? (
        <span id={formControl.errorId} data-pyric-error-message>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export const stringEditor: FieldEditorContract<string> = {
  type: 'string',
  Display: StringDisplay,
  Edit: StringEdit,
};
