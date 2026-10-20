/**
 * `firebase/app-check` under the sandbox: pyric's deferred App Check entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Firebase App Check SDK.
 */
export * from 'pyric/app-check';
