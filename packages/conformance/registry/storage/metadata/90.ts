import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["getMetadata","updateMetadata"],
  behavior: "Prod: `updateMetadata({customMetadata: {...}})` round-trips through a follow-up `getMetadata`",
  status: "conforms",
  statusNote: "(prod-only)",
  evidence: "oracle: `packages/conformance/observations/storage/storage-update-metadata-roundtrip.json` (against digame-mas, fb-js-sdk 12.19.0: post-update `getMetadata` returns the exact `customMetadata` object, `metageneration` bumps `'1'` → `'2'`, `customSurvived: true`, `metagenerationBumped: true`)",
  risk: ["specific-value","specific-field","metadata"],
  riskScore: 4,
  riskReasons: ["asserts 2 specific value(s)","asserts a specific field/property value","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-update-metadata-roundtrip"],
});
