/** RTDB environment controls and server-value construction for served apps. */
export function rtdbServerTimestamp(): { readonly __rtdbSentinel: 'serverTimestamp' } {
  return { __rtdbSentinel: 'serverTimestamp' };
}

export function rtdbConnectDatabaseEmulator(): void {
  // Served SharedWorker mode is already sandbox-local.
}
