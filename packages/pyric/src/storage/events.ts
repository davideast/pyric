/**
 * What the storage surface puts on the sandbox event stream.
 *
 * The sandbox core reads this record to derive the `storage` arm of
 * `ServiceMutationEvent`; `upload.ts`, `download.ts`, and `metadata.ts` are
 * typed against the operations declared here.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const STORAGE_EVENT_RECORD = {
  service: 'storage',
  operations: ['object_put', 'object_delete', 'metadata_update'],
  target: {
    name: 'fullPath',
    description: "The object's full path within the bucket, e.g. avatars/alice.png.",
    always: true,
  },
} as const satisfies ServiceEventRecord;

/** Every operation the storage surface emits. */
export type StorageEventOperation = (typeof STORAGE_EVENT_RECORD)['operations'][number];
