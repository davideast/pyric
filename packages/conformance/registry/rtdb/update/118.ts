import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Multi-path update is atomic: if any path is denied by rules, the entire update rejects and no path is written",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-rules-denial.json` — observed `threw: true, code: 'PERMISSION_DENIED'` AND `okPathWrittenDespiteDenial: false` (the otherwise-permitted path also rolled back). The sandbox's activity record matches: `unit:sandbox/write-plane.test.ts` checks that a denied update records only its denial, with no allow for the paths evaluated before it.",
  risk: ["specific-field","atomicity","rules-denial"],
  riskScore: 5,
  riskReasons: ["asserts a specific field/property value","asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-update-multipath-rules-denial"],
  conformanceTests: ["packages/pyric/test/database/sandbox/write-plane.test.ts"],
  aliases: ["rtdb#118"],
});
