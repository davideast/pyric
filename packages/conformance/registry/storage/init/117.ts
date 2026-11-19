import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ['getStorageSandbox'],
  behavior:
    'Pyric documents that carry Storage bytes inline as base64 in one JSON string (the in-process `storage.json`, a `--persist` state file, a fixture export, an inline state capture, and branch files) refuse a total past `MAX_INLINE_STORAGE_BYTES` with `storage/quota-exceeded`, naming the limit, the total, and the by-reference alternative, before any byte is encoded or written',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence:
    '`unit:sandbox/internal/inline-storage-limit.test.ts` pins the limit, base64 length counting with and without the Node `Buffer` global, the refusal of inline captures, and branch saves that write nothing. `packages/cli/test/serve/inline-storage-limit.test.ts` pins the in-process storage file, the `--persist` state file, a fixture export, and a fork through the `sandbox` tool. This is Pyric behavior with no production equivalent: production Storage keeps no such documents.',
  risk: ['error-code'],
  riskReasons: ['asserts Firebase error code(s): `storage/quota-exceeded`'],
  conformanceTests: [
    'packages/pyric/test/sandbox/internal/inline-storage-limit.test.ts',
    'packages/cli/test/serve/inline-storage-limit.test.ts',
  ],
  exceptionReason:
    'Pyric-native MAX_INLINE_STORAGE_BYTES guard on inline JSON state snapshots and sidecars; production Cloud Storage has no inline JSON state documents.',
});
