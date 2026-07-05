import type { DocumentReference } from 'pyric/firestore';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';
import { useDisplayContext } from '../components/context.js';

function ReferenceDisplay({ value, path }: FieldDisplayProps<DocumentReference>) {
  // Clickable when a consumer has wired `onReferenceClick` via the
  // `<DocumentPreview onReferenceClick={…}>` prop. Otherwise renders
  // as plain text — staying headless and avoiding fake interactivity.
  const { onReferenceClick } = useDisplayContext();
  if (onReferenceClick) {
    return (
      <button
        type="button"
        onClick={() => onReferenceClick(value)}
        data-pyric-field-type="reference"
        data-pyric-field-path={path}
        data-target-path={value.path}
        data-pyric-clickable=""
      >
        {value.path}
      </button>
    );
  }
  return (
    <span
      data-pyric-field-type="reference"
      data-pyric-field-path={path}
      data-target-path={value.path}
    >
      {value.path}
    </span>
  );
}

/**
 * Text-input reference editor. M3 only — the M5 `<ReferencePicker>`
 * replaces this with a popover that browses the data plane. The
 * editor commits a "ref-shaped" stand-in object (matching the
 * structural check in `inferType` + `validateLeaf`) so the value
 * flows through the reducer without needing a live Firestore handle
 * at this layer.
 */
function ReferenceEdit({ value, onChange, error, path }: FieldEditProps<DocumentReference>) {
  return (
    <label
      data-pyric-field-type="reference"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <input
        type="text"
        value={value.path}
        placeholder="users/alice"
        onChange={(e) => {
          const nextPath = e.target.value;
          const segments = nextPath.split('/').filter(Boolean);
          const id = segments[segments.length - 1] ?? '';
          // Build a ref-shaped stand-in. Real refs are constructed
          // by `<ReferencePicker>` (M5) once it can talk to a
          // Firestore handle.
          // Preserve the existing firestore handle if the current
          // value already carries one (so it can be wired back when
          // the M5 picker arrives). Cast through `unknown` because
          // the @pyric/firestore type union doesn't expose
          // `.firestore` uniformly across chainable + modular.
          const existingFirestore =
            (value as unknown as { firestore?: unknown }).firestore ?? {};
          const stand = {
            path: nextPath,
            id,
            firestore: existingFirestore,
            type: 'document',
          } as unknown as DocumentReference;
          onChange(stand);
        }}
        aria-invalid={error ? 'true' : undefined}
      />
      {error ? <span data-pyric-error-message>{error}</span> : null}
    </label>
  );
}

export const referenceEditor: FieldEditorContract<DocumentReference> = {
  type: 'reference',
  Display: ReferenceDisplay,
  Edit: ReferenceEdit,
};
