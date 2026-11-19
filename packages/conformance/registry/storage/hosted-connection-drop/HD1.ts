import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["uploadBytesResumable", "getMetadata"],
  api: "Operations in flight at a hosted connection drop (web hosted client)",
  behavior: "A Storage operation (`getMetadata`, `deleteObject`, `list`, or an upload step) the web hosted client's socket had taken when it dropped fails once with `unavailable` and the message \"The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.\" It is not sent again. In production the Storage Web SDK retries a request that fails on the network with exponential backoff, for up to 2 minutes for an operation and 10 minutes for an upload, and then fails it with `storage/retry-limit-exceeded`.",
  statusNote: "fails at once with `unavailable` where production retries, then fails with `storage/retry-limit-exceeded`",
  evidence: "Production behavior read from `@firebase/storage` 0.14.3 `dist/index.esm.js`: `DEFAULT_MAX_OPERATION_RETRY_TIME` (2 minutes), `DEFAULT_MAX_UPLOAD_RETRY_TIME` (10 minutes), and `retryLimitExceeded()` in the request retry loop. `packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts` drops a real loopback socket with `storage.getMetadata` and `storage.deleteObject` in flight and asserts each fails once with that message and reaches the host once.",
  conformanceTests: ["packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts"],
});
