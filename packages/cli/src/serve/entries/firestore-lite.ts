/**
 * `firebase/firestore/lite` under the sandbox: pyric's deferred lite entry.
 * Imports resolve and link; a call throws `PyricDeferredApiError` naming the
 * subpath, rather than reaching the real Firestore Lite SDK.
 */
export * from 'pyric/firestore/lite';
