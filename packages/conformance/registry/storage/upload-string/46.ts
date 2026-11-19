import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`uploadString(ref, value, 'base64')` round-trips via `getDownloadURL` + fetch across in-page sandbox and SharedWorker mode",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-uploadstring-base64-roundtrip.json` (`'aGVsbG8='` → `'hello'` against digame-mas, fb-js-sdk 12.19.0; `textMatches: true`). Sandbox oracle replay matches production behavior in-page, and client↔host integration proves SharedWorker mode decodes and transfers string payloads faithfully over the worker port.",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 2 specific value(s)","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-base64-roundtrip"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/integration.test.ts"],
});
