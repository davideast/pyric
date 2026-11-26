import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['list'],
  api: 'list(ref, options?)',
  behavior:
    'Exported by `firebase/storage`; accepts `{ maxResults, pageToken }` (`maxResults` integer in `1..1000`, default `1000`), enforces `method: "list"` Storage Security Rules, orders mixed items and rolled-up prefixes in UTF-8 byte order, and returns a `ListResult` with `nextPageToken` present only when more entries remain.',
  status: 'conforms',
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric/test/storage/list.test.ts',
    'packages/cli/test/serve/worker/storage-list-parity.test.ts',
  ],
  evidence:
    'Verified across in-process `pyric/storage`, served entry + SharedWorker, and Node-hosted WebSocket `HostedRuntime` planes (pagination boundaries, mixed items and prefixes, `maxResults` validation, malformed `pageToken` rejection, cross-runtime non-Buffer cursor fallback, `method: "list"` rules enforcement, and multi-bucket `list()`) in `packages/pyric/test/storage/list.test.ts` and `packages/cli/test/serve/worker/storage-list-parity.test.ts`.',
  risk: ['specific-value', 'stateful'],
  riskScore: 3,
  riskReasons: ['asserts pagination boundaries, cursor decoding, invalid-argument validation, and fail-closed list rules enforcement'],
});
