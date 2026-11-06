/**
 * The one reading of a Storage operation's target that every traffic view
 * shares: the runtime chip's Traffic panel and Studio show a Storage row as
 * `gs://<bucket>/<path>`, the way Studio's StoragePane shows an object.
 */
import type { SandboxEvent } from '../types/events.js';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The bucket a Storage operation names, sandbox or production. The sandbox
 * keeps its store key (`pyric-default`) in `detail.bucket` and the app's name
 * for the bucket in `detail.bucketName`; production sends only `bucket`.
 */
function storageBucket(event: SandboxEvent): string | undefined {
  const isStorageOperation = event.kind === 'operation' && event.service === 'storage';
  if (!isStorageOperation) return undefined;
  const detail = event.detail;
  return nonEmptyString(detail?.bucketName) ?? nonEmptyString(detail?.bucket);
}

/**
 * A Storage operation's target as `gs://<bucket>/<path>`, and `gs://<bucket>/`
 * for the bucket's root. `undefined` for an event that names no Storage
 * bucket, so each view keeps its own fallback.
 */
export function storageGsPath(event: SandboxEvent, path: string | undefined): string | undefined {
  const bucket = storageBucket(event);
  if (bucket === undefined) return undefined;
  const objectPath = (path ?? '').replace(/^\/+/, '');
  return `gs://${bucket}/${objectPath}`;
}
