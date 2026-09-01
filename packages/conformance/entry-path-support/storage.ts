import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

const OPEN_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

/** Supply deployed rules without adding harness-only APIs to the entry corpus. */
export function createConfiguredStorageApp() {
  const sandbox = initializeSandbox();
  getAdminStorageSandbox(sandbox, { rules: OPEN_RULES });
  return createAppForSandbox(
    sandbox,
    { projectId: 'entry-path-project' },
    'entry-path-storage',
  );
}
