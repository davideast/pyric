import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["list"],
  api: "list(ref, options?)",
  behavior: "Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain",
  status: "unsupported",
  evidence: "No paginated `list` implementation or behavioral probe exists; availability is classified by the owning surface contract. `ListResult.nextPageToken` remains optional for forward-compatible consumer code.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  automation: "unsupported",
  exceptionReason: "Behavior is unimplemented; availability is contract-owned.",
});
