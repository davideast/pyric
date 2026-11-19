import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["signInWithEmailAndPassword"],
  api: "Operations in flight at a hosted connection drop (web hosted client)",
  behavior: "An Auth operation (a sign-in, a profile update, a token refresh) the web hosted client's socket had taken when it dropped fails once with `unavailable` and the message \"The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.\" It is not sent again. In production the Auth Web SDK fails a request whose network call fails with `auth/network-request-failed` and does not retry it.",
  statusNote: "fails with `unavailable` where production fails with `auth/network-request-failed`",
  evidence: "Production behavior read from `@firebase/auth` 1.13.1 `dist/esm`: a failed `fetch` is reported through `_fail(auth, \"network-request-failed\")`, and the request is not retried. `packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts` drops a real loopback socket with `auth.signInEmail` in flight and asserts it fails once with that message and reaches the host once.",
  conformanceTests: ["packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts"],
});
