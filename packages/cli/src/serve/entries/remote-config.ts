/**
 * `firebase/remote-config` under the sandbox: pyric's deferred Remote Config entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Remote Config SDK.
 */
export * from 'pyric/remote-config';
