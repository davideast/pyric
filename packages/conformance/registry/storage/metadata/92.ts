import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["getMetadata","updateMetadata"],
  behavior: "`FullMetadata.ref` lazy population (prod populates lazily)",
  status: "unsupported",
  evidence: "not modeled in `pyric/storage` — `metadata.ts` explicitly omits `ref` from `FullMetadata`",
  risk: ["specific-value","metadata"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts metadata shape"],
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
