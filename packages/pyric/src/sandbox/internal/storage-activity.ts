import { sdkActivity, type SdkActivityHandle } from './sdk-activity.js';
import type { UsageEvidence } from './usage-evidence.js';

interface StorageSource { readonly storage?: object; readonly port?: object; readonly bucket: string; readonly fullPath: string }
const tasks = new WeakMap<object, SdkActivityHandle>();
/** Called immediately before a real application observer; no payload is retained. */
export function storageTaskProgress(task: object): void { tasks.get(task)?.progress(); }
export function storageTaskResult(task: object): void {
  const activity = tasks.get(task);
  activity?.delivered(undefined, {});
  // Each callback gets its own render window, but the result is counted once.
  activity?.progress();
}
/** Preserve promises and UploadTask handles; observe completion without wrapping them. */
export function observeStorageOperation<S extends StorageSource, A extends unknown[], R extends PromiseLike<unknown>>(
  method: string, operation: (ref: S, ...args: A) => R,
): (ref: S, ...args: A) => R {
  return (ref, ...args) => {
    const activity = sdkActivity.begin({ app: ref.storage ?? ref.port ?? ref, method, kind: 'operation',
      source: { service: 'storage', target: `${ref.bucket}/${ref.fullPath}`, key: `storage:${ref.bucket}/${ref.fullPath}` } });
    try {
      const result = operation(ref, ...args);
      if (method === 'uploadBytesResumable') tasks.set(result, activity);
      void result.then(value => {
        const usage: UsageEvidence = storageUsage(method, value);
        // Results open a render window; byte usage is recorded once at its original boundary.
        activity.delivered(undefined, method.startsWith('get') || method === 'listAll' ? usage : {});
        if (method === 'uploadBytesResumable') activity.progress();
        activity.complete(method.startsWith('get') || method === 'listAll' ? undefined : usage);
      }, () => { activity.fail(); tasks.delete(result); });
      return result;
    } catch (error) { activity.fail(); throw error; }
  };
}
function storageUsage(method: string, value: unknown): UsageEvidence {
  if (method === 'getBytes' && value instanceof ArrayBuffer) return { downloadedBytes: value.byteLength };
  if (method === 'getBlob' && value && typeof value === 'object' && 'size' in value && typeof value.size === 'number') return { downloadedBytes: value.size };
  if (method.startsWith('upload') && value && typeof value === 'object' && 'metadata' in value) {
    const metadata = value.metadata as { size?: number };
    if (typeof metadata.size === 'number') return { uploadedBytes: metadata.size };
  }
  return {};
}
