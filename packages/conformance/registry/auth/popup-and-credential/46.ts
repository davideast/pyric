import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Mock is consumed after one read (subsequent call without a fresh stage throws again)",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts"],
});
