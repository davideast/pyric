import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`onAbort` semantics: when a callback throws, every `onAbort` registered by a callback that ALREADY SUCCEEDED in the same pass runs, in REVERSE registration order — matches upstream's rollback-stack (`runMiddleware`'s `onAbortStack`). An `onAbort` that itself throws is swallowed so it can't mask the original block reason or skip the remaining rollbacks.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["listener","specific-value"],
  riskScore: 4,
  rowNumber: 76,
  evidence: "`oracle:auth-beforeauthstatechanged-onabort-reverse-and-swallow` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page); `unit:sandbox-before-auth-state-changed.test.ts`",
  riskReasons: ["asserts listener semantics","asserts a specific value"],
  oracleObservations: ["auth-beforeauthstatechanged-onabort-reverse-and-swallow"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-before-auth-state-changed.test.ts"],
});
