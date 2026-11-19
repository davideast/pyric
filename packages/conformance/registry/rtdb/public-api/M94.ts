import { row } from './section.ts';

export default row({
  order: 1070,
  featureKeys: ["query","orderByChild","orderByKey","orderByPriority","orderByValue","startAt","startAfter","endAt","endBefore","equalTo","limitToFirst","limitToLast"],
  behavior: "Query constraint construction preserves Firebase's synchronous validation for limits, child paths, cursor keys, undefined/non-finite/object endpoint values, and index-specific endpoint compatibility, including the captured +Infinity and server-value priority acceptances",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-query-construction-validation` repeats the complete validation matrix twice per run and matched across two clean production runs; `unit:modular/query-validation.test.ts` replays every captured field exactly.",
  risk: ["validation-timing","specific-value"],
  riskScore: 3,
  riskReasons: ["asserts synchronous validation phase","asserts exact validation error shapes"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-construction-validation"],
  conformanceTests: ["packages/pyric/test/database/modular/query-validation.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M94",
    observation: "rtdb-modular-query-construction-validation",
    expect: { repeatCount: 2, contractDigest: "d8e121139846b37dec3df876f9f26256af5b32459377dc4ecfac7a01c2a1f362", normalWriteControl: { control: true } },
    probe: "packages/pyric/test/database/modular/query-validation.test.ts",
    guards: "The complete query-construction validation matrix stays byte-pinned through its production digest and exact sandbox replay.",
  }],
  rowNumber: 94,
});
