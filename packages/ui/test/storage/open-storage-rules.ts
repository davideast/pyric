/**
 * Explicitly permissive rules for tests that exercise UI behavior, not security.
 * Version 2, so `{path=**}` also matches zero segments and a list of the
 * bucket root is allowed; under version 1 a recursive wildcard needs one.
 */
export const OPEN_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;
