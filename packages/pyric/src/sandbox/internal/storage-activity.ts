import { sdkActivity } from './sdk-activity.js';
import type { UsageEvidence } from './usage-evidence.js';

interface StorageSource { readonly storage?: object; readonly port?: object; readonly bucket: string; readonly fullPath: string }
/** Preserve promises and UploadTask handles; observe completion without wrapping them. */
export function observeStorageOperation<S extends StorageSource, A extends unknown[], R extends PromiseLike<unknown>>(
  method: string, operation: (ref: S, ...args: A) => R,
): (ref: S, ...args: A) => R {
  return (ref, ...args) => {
    const activity = sdkActivity.begin({ app: ref.storage ?? ref.port ?? ref, method, kind: 'operation',
      source: { service: 'storage', target: `${ref.bucket}/${ref.fullPath}`, key: `storage:${ref.bucket}/${ref.fullPath}` } });
    try {
      const result = operation(ref, ...args);
      void result.then(value => {
        const usage: UsageEvidence = storageUsage(method, value);
        if (method.startsWith('get') || method === 'listAll') activity.delivered(undefined, usage);
        activity.complete(method.startsWith('get') || method === 'listAll' ? undefined : usage);
      }, () => activity.fail());
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
