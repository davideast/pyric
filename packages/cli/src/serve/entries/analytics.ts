/**
 * `firebase/analytics` under the sandbox: pyric's deferred analytics entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Firebase Analytics SDK.
 */
export * from 'pyric/analytics';
