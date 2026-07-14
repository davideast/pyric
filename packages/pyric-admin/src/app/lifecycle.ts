const deletedApps = new WeakSet<object>();

/** Internal lifecycle guard shared by every pyric-admin service factory. */
export function assertAdminAppActive(app: object & { readonly name: string }): void {
  if (!deletedApps.has(app)) return;
  const error = new Error(
    `Firebase app named "${app.name}" has already been deleted.`,
  ) as Error & { code: string };
  error.name = 'FirebaseAppError';
  error.code = 'app/app-deleted';
  throw error;
}

/** Tombstone a wrapper while leaving the caller-owned Sandbox alive. */
export function markAdminAppDeleted(app: object): void {
  deletedApps.add(app);
}
