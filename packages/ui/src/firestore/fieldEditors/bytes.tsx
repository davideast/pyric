import { Bytes } from 'pyric/firestore';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function BytesDisplay({ value, path }: FieldDisplayProps<Bytes>) {
  const b64 = value.toBase64();
  return (
    <code
      data-pyric-field-type="bytes"
      data-pyric-field-path={path}
      data-byte-length={String(value.toUint8Array().byteLength)}
    >
      {b64}
    </code>
  );
}

/**
 * Base64 textarea. Anything that's not legal base64 produces a
 * thrown error when passed to `Bytes.fromBase64String`; we swallow
 * it and leave the old value in place. The validator surfaces the
 * stale state by not flagging it (the underlying Bytes is still
 * valid), so consumers wanting stricter feedback need to swap the
 * editor.
 */
function BytesEdit({ value, onChange, error, path }: FieldEditProps<Bytes>) {
  return (
    <label
      data-pyric-field-type="bytes"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <textarea
        value={value.toBase64()}
        onChange={(e) => {
          try {
            onChange(Bytes.fromBase64String(e.target.value));
          } catch {
            // Invalid base64 — keep the previous value. The user
            // sees the bad text in the textarea until they fix it.
          }
        }}
        aria-invalid={error ? 'true' : undefined}
      />
      {error ? <span data-pyric-error-message>{error}</span> : null}
    </label>
  );
}

export const bytesEditor: FieldEditorContract<Bytes> = {
  type: 'bytes',
  Display: BytesDisplay,
  Edit: BytesEdit,
};
