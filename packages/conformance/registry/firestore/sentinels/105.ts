import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["FieldValue"],
  behavior: "`FieldValue` re-exported from `pyric-admin` (alias of `ChainFieldValue`)",
  evidence: "type-only smoke",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "type-backed",
  exceptionReason: "structural / type shape — verified without a prod observation",
});
