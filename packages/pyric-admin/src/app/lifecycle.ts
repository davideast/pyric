import { FirebaseAppError } from 'firebase-admin/app';

const deletedApps = new WeakSet<object>();

const AdminAppError = FirebaseAppError as unknown as new (
  code: string,
  message: string,
) => Error & { readonly code: string };

/** Internal lifecycle guard shared by every pyric-admin service factory. */
export function assertAdminAppActive(app: object & { readonly name: string }): void {
  if (deletedApps.has(app)) {
    throw new AdminAppError(
      'app-deleted',
      `Firebase app named "${app.name}" has already been deleted.`,
    );
  }
}

/** Tombstone a wrapper while leaving the caller-owned Sandbox alive. */
export function markAdminAppDeleted(app: object): void {
  deletedApps.add(app);
}
