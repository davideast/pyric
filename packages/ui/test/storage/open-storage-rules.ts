/** Explicitly permissive rules for tests that exercise UI behavior, not security. */
export const OPEN_STORAGE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;
