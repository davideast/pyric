import { Fragment } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import { useAuthUserEditor } from '../hooks/useAuthUserEditor.js';
import { ClaimsField } from './ClaimsField.js';

/** What `onSubmit` receives — discriminated on the form's mode. */
export type AuthUserFormSubmit =
  | { mode: 'create'; request: CreateUserRequest }
  | { mode: 'edit'; uid: string; request: UpdateUserRequest };

/** Field names the {@link AuthUserFormProps.renderField} slot receives,
 *  in render order. Claims is NOT a slot field — it stays the standalone
 *  `<ClaimsField>` (override it by composing `useAuthUserEditor`). */
export type AuthUserFormFieldName =
  | 'email'
  | 'password'
  | 'display-name'
  | 'phone-number'
  | 'photo-url'
  | 'email-verified'
  | 'disabled';

/** What the {@link AuthUserFormProps.renderField} slot receives per field. */
export interface AuthUserFormField {
  name: AuthUserFormFieldName;
  /** The visible label text the default rendering uses. */
  label: string;
  /** The wired, controlled input element (carries `data-pyric-field`).
   *  Place it anywhere; state/validation stay connected. */
  input: ReactNode;
  /** Current validation message for this field, or null. */
  error: string | null;
  /** `'text' | 'checkbox'` — lets one slot impl branch on layout. */
  kind: 'text' | 'checkbox';
  /** The default rendering (label wrapper + label text + input + error).
   *  Call it to keep the stock layout for fields you don't customize. */
  defaultRender: () => ReactNode;
}

export interface AuthUserFormProps {
  /** Existing record → edit mode (delta payloads); omit → create mode. */
  initial?: AuthUserRecord;
  /** Receives the validated payload. Wire `create` to
   *  `useAuthUsers().createUser` and `edit` to `updateUser`. */
  onSubmit: (submit: AuthUserFormSubmit) => void;
  onCancel?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  /** Extra content rendered before the action row (e.g. an error from a
   *  failed `createUser` call). */
  children?: ReactNode;
  className?: string;
  /** Per-field layout override. Called for each field (see
   *  {@link AuthUserFormFieldName} order); return your own markup around
   *  `field.input`, or `field.defaultRender()` to keep the stock label
   *  wrapper for that field. Omit the prop for the default layout. */
  renderField?: (field: AuthUserFormField) => ReactNode;
}

/**
 * Headless add/edit-user form over `useAuthUserEditor` — the emulator
 * UI's user dialog fields (email, password, display name, phone, photo
 * URL, verified/disabled toggles, custom claims) with its validation
 * messages. Zero CSS; structure addressable via `data-pyric-*`:
 *
 * - root `form[data-pyric-ui="auth-user-form"]` with `data-pyric-mode`,
 *   `data-pyric-is-dirty`, `data-pyric-is-valid` state attrs
 * - every field (text inputs AND checkboxes) is wrapped in a
 *   `label[data-pyric-field-label="<name>"]` carrying a visible
 *   `span[data-pyric-label-text]` — labeled grid layouts are pure CSS
 *   (`display: grid` on the wrappers); label-less designs hide
 *   `[data-pyric-label-text]` and lean on the placeholders
 * - inputs `[data-pyric-field="email" | "password" | "display-name" |
 *   "phone-number" | "photo-url" | "email-verified" | "disabled"]`
 * - claims via the standalone `<ClaimsField>`
 * - per-field messages `[data-pyric-field-error="email" | "password"]`
 *   render INSIDE the field's label wrapper, after the input
 * - `button[data-pyric-cancel]` / `button[data-pyric-submit]` (submit is
 *   disabled while invalid, or pristine in edit mode)
 *
 * Submit emits payloads only — no sandbox calls — so the same form works
 * for create and edit and the consumer owns error handling.
 */
export function AuthUserForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  children,
  className,
  renderField,
}: AuthUserFormProps) {
  const editor = useAuthUserEditor({ initial });
  const mode = initial ? 'edit' : 'create';
  const submittable = editor.isValid && (mode === 'create' || editor.isDirty);

  /** Build one field descriptor: the wired input + the stock label-wrapper
   *  rendering. `renderField` consumers place `input` themselves. */
  const field = (
    name: AuthUserFormFieldName,
    label: string,
    kind: 'text' | 'checkbox',
    input: ReactNode,
    error: string | null = null,
  ): AuthUserFormField => ({
    name,
    label,
    input,
    error,
    kind,
    defaultRender: () =>
      kind === 'checkbox' ? (
        <label data-pyric-field-label={name} key={name}>
          {input}
          <span data-pyric-label-text>{label}</span>
        </label>
      ) : (
        <label data-pyric-field-label={name} key={name}>
          <span data-pyric-label-text>{label}</span>
          {input}
          {error != null && (
            <p role="alert" data-pyric-field-error={name}>
              {error}
            </p>
          )}
        </label>
      ),
  });

  const fields: AuthUserFormField[] = [
    field(
      'email',
      'Email',
      'text',
      <input
        type="email"
        data-pyric-field="email"
        placeholder="email@example.com"
        value={editor.fields.email}
        onChange={(e) => editor.setField('email', e.target.value)}
      />,
      editor.errors.email ?? null,
    ),
    field(
      'password',
      'Password',
      'text',
      <input
        type="password"
        data-pyric-field="password"
        placeholder={mode === 'edit' ? 'New password (unchanged if empty)' : 'Password'}
        value={editor.fields.password}
        onChange={(e) => editor.setField('password', e.target.value)}
      />,
      editor.errors.password ?? null,
    ),
    field(
      'display-name',
      'Display name',
      'text',
      <input
        type="text"
        data-pyric-field="display-name"
        placeholder="Display name (optional)"
        value={editor.fields.displayName}
        onChange={(e) => editor.setField('displayName', e.target.value)}
      />,
    ),
    field(
      'phone-number',
      'Phone number',
      'text',
      <input
        type="tel"
        data-pyric-field="phone-number"
        placeholder="+1 555 555 0100"
        value={editor.fields.phoneNumber}
        onChange={(e) => editor.setField('phoneNumber', e.target.value)}
      />,
    ),
    field(
      'photo-url',
      'Photo URL',
      'text',
      <input
        type="url"
        data-pyric-field="photo-url"
        placeholder="https://example.com/avatar.png"
        value={editor.fields.photoUrl}
        onChange={(e) => editor.setField('photoUrl', e.target.value)}
      />,
    ),
    field(
      'email-verified',
      'Verified email',
      'checkbox',
      <input
        type="checkbox"
        data-pyric-field="email-verified"
        checked={editor.fields.emailVerified}
        onChange={(e) => editor.setField('emailVerified', e.target.checked)}
      />,
    ),
    field(
      'disabled',
      'Disabled (sign-in attempts are rejected)',
      'checkbox',
      <input
        type="checkbox"
        data-pyric-field="disabled"
        checked={editor.fields.disabled}
        onChange={(e) => editor.setField('disabled', e.target.checked)}
      />,
    ),
  ];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!submittable) return;
    if (mode === 'edit') {
      onSubmit({ mode, uid: initial!.uid, request: editor.toUpdateRequest() });
    } else {
      onSubmit({ mode, request: editor.toCreateRequest() });
    }
  };

  return (
    <form
      className={className}
      data-pyric-ui="auth-user-form"
      data-pyric-mode={mode}
      data-pyric-is-dirty={editor.isDirty ? '' : undefined}
      data-pyric-is-valid={editor.isValid ? '' : undefined}
      onSubmit={submit}
    >
      {fields.map((f) =>
        renderField ? (
          <Fragment key={f.name}>{renderField(f)}</Fragment>
        ) : (
          f.defaultRender()
        ),
      )}
      <ClaimsField
        value={editor.fields.claimsText}
        onChange={(text) => editor.setField('claimsText', text)}
        error={editor.errors.claims}
      />
      {children}
      <footer data-pyric-form-actions>
        {onCancel ? (
          <button type="button" data-pyric-cancel onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
        <button type="submit" data-pyric-submit disabled={!submittable}>
          {submitLabel}
        </button>
      </footer>
    </form>
  );
}
