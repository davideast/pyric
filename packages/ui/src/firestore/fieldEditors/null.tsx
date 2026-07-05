import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function NullDisplay({ path }: FieldDisplayProps<null>) {
  return (
    <span data-pyric-field-type="null" data-pyric-field-path={path}>
      null
    </span>
  );
}

// `null` has no editable surface — the user changes the type if they
// want a value. The Edit component renders a placeholder so the
// editor still emits a slot at the right path. Consumers style it
// however they like (e.g. ghost text).
function NullEdit({ path }: FieldEditProps<null>) {
  return (
    <span data-pyric-field-type="null" data-pyric-field-path={path}>
      null
    </span>
  );
}

export const nullEditor: FieldEditorContract<null> = {
  type: 'null',
  Display: NullDisplay,
  Edit: NullEdit,
};
