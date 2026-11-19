import { row } from './section.ts';

export default row({
  order: 140,
  behavior: "Returned `metadata.contentType` matches what the caller hinted (when set)",
  evidence: "`unit:reference.test.ts` + oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (`contentType: 'application/octet-stream'` round-trip against digame-mas, fb-js-sdk 12.19.0; `contentTypeMatches: true`)",
  risk: ["specific-field","metadata"],
  riskScore: 2,
  riskReasons: ["asserts a specific field/property value","asserts metadata shape"],
  oracleObservations: ["storage-upload-then-getmetadata"],
  conformanceTests: ["packages/pyric/test/storage/reference.test.ts"],
});
