/** RTDB environment controls and server-value construction for served apps. */
export function rtdbServerTimestamp(): { readonly '.sv': 'timestamp' } {
  return { '.sv': 'timestamp' };
}

export function rtdbConnectDatabaseEmulator(): void {
  // Served SharedWorker mode is already sandbox-local.
}
