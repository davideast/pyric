import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getStream"],
  api: "getStream(ref, maxDownloadSize?)",
  behavior: "Exported by `firebase/storage` (Node entry only); returns a Node `Readable`",
  status: "unsupported",
  evidence: "No `pyric/storage` implementation or behavioral probe exists; availability is classified by the owning surface contract.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  automation: "unsupported",
  exceptionReason: "Behavior is unimplemented; availability is contract-owned.",
});
