/**
 * `firebase/performance` under the sandbox: pyric's deferred Performance entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Firebase Performance SDK.
 */
export * from 'pyric/performance';
