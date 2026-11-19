import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Registry is array-backed (matches upstream `util/subscribe.ts`): the SAME observer fn registered N times produces N independent registrations that each fire, and one `Unsubscribe` removes exactly one registration. A resubscribe of a previously-unsubscribed fn fires its initial value again. (Per-registration initial-fire bookkeeping, not a shared per-observer dedup.)",
  evidence: "`oracle:auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page + served worker); `unit:sandbox-listener-registry.test.ts`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  rowNumber: 33,
  oracleObservations: ["auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-listener-registry.test.ts"],
});
