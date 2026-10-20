/**
 * `firebase/functions` under the sandbox: pyric's deferred Functions entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Cloud Functions client SDK.
 */
export * from 'pyric/functions';
