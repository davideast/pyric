/**
 * Reducer behind `useAuthUserEditor` — pure, React-free (drivable from
 * tests or non-React hosts, like the firestore `documentEditor` reducer).
 *
 * Validation messages match the Firebase emulator UI:
 * - email pattern → "Invalid email"
 * - password length → "Password should be at least 6 characters"
 * - password without email → "Email is required for password authentication"
 * - claims → `validateSerializedClaims` messages
 */
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import { validateSerializedClaims } from '../claims.js';

/** Editable field set. `claimsText` is the raw textarea JSON. */
export interface AuthUserEditorFields {
  email: string;
  password: string;
  displayName: string;
  phoneNumber: string;
  photoUrl: string;
  emailVerified: boolean;
  disabled: boolean;
  claimsText: string;
}

export interface AuthUserEditorState {
  fields: AuthUserEditorFields;
  /** What {@link reset} returns to; dirtiness is measured against this. */
  initial: AuthUserEditorFields;
}

export type AuthUserEditorAction =
  | {
      type: 'setField';
      field: keyof AuthUserEditorFields;
      value: AuthUserEditorFields[keyof AuthUserEditorFields];
    }
  | { type: 'reset' };

export interface AuthUserEditorErrors {
  email?: string;
  password?: string;
  claims?: string;
}

const EMPTY_FIELDS: AuthUserEditorFields = {
  email: '',
  password: '',
  displayName: '',
  phoneNumber: '',
  photoUrl: '',
  emailVerified: false,
  disabled: false,
  claimsText: '',
};

/** Same permissive shape the emulator UI uses (`pattern` validation). */
const EMAIL_REGEX = /^[^@]+@[^@]+\.[^@]+$/;
const PASSWORD_MIN_LENGTH = 6;

export function fieldsFromRecord(record?: AuthUserRecord): AuthUserEditorFields {
  if (!record) return { ...EMPTY_FIELDS };
  return {
    email: record.email ?? '',
    password: '',
    displayName: record.displayName ?? '',
    phoneNumber: record.phoneNumber ?? '',
    photoUrl: record.photoUrl ?? '',
    emailVerified: record.emailVerified,
    disabled: record.disabled,
    claimsText: Object.keys(record.customClaims).length
      ? JSON.stringify(record.customClaims, null, 2)
      : '',
  };
}

export function initAuthUserEditorState(initial?: AuthUserRecord): AuthUserEditorState {
  const fields = fieldsFromRecord(initial);
  return { fields, initial: { ...fields } };
}

export function authUserEditorReducer(
  state: AuthUserEditorState,
  action: AuthUserEditorAction,
): AuthUserEditorState {
  switch (action.type) {
    case 'setField':
      return { ...state, fields: { ...state.fields, [action.field]: action.value } };
    case 'reset':
      return { ...state, fields: { ...state.initial } };
  }
}

export function validateAuthUserFields(fields: AuthUserEditorFields): AuthUserEditorErrors {
  const errors: AuthUserEditorErrors = {};
  const email = fields.email.trim();
  const password = fields.password;
  if (email && !EMAIL_REGEX.test(email)) {
    errors.email = 'Invalid email';
  }
  if (password && password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password should be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password && !email) {
    errors.password = 'Email is required for password authentication';
  }
  const claims = validateSerializedClaims(fields.claimsText);
  if (!claims.ok) errors.claims = claims.message;
  return errors;
}

export function isDirty(state: AuthUserEditorState): boolean {
  const { fields, initial } = state;
  return (Object.keys(fields) as Array<keyof AuthUserEditorFields>).some(
    (k) => fields[k] !== initial[k],
  );
}

function parsedClaims(fields: AuthUserEditorFields): Record<string, unknown> | undefined {
  const r = validateSerializedClaims(fields.claimsText);
  return r.ok ? r.claims : undefined;
}

/** Full payload for `sandbox.createUser` — every non-empty field. */
export function toCreateRequest(state: AuthUserEditorState): CreateUserRequest {
  const f = state.fields;
  const req: CreateUserRequest = {
    emailVerified: f.emailVerified,
    disabled: f.disabled,
  };
  if (f.email.trim()) req.email = f.email.trim();
  if (f.password) req.password = f.password;
  if (f.displayName.trim()) req.displayName = f.displayName.trim();
  if (f.phoneNumber.trim()) req.phoneNumber = f.phoneNumber.trim();
  if (f.photoUrl.trim()) req.photoUrl = f.photoUrl.trim();
  const claims = parsedClaims(f);
  if (claims) req.customClaims = claims;
  return req;
}

/** Delta payload for `sandbox.updateUser` — only fields that changed
 *  from the initial record. A cleared displayName maps to `null`
 *  (the update API's clear semantics). */
export function toUpdateRequest(state: AuthUserEditorState): UpdateUserRequest {
  const { fields: f, initial: i } = state;
  const req: UpdateUserRequest = {};
  if (f.email.trim() !== i.email && f.email.trim()) req.email = f.email.trim();
  if (f.password && f.password !== i.password) req.password = f.password;
  if (f.displayName.trim() !== i.displayName) {
    req.displayName = f.displayName.trim() || null;
  }
  if (f.emailVerified !== i.emailVerified) req.emailVerified = f.emailVerified;
  if (f.disabled !== i.disabled) req.disabled = f.disabled;
  if (f.claimsText !== i.claimsText) {
    req.customClaims = parsedClaims(f) ?? {};
  }
  return req;
}
