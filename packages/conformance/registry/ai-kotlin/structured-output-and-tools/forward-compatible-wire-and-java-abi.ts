import { row } from './section.ts';

export default row({
  order: 30,
  api: "CitationMetadata / HarmSeverity / forward-compatible wire part skipping / @JvmStatic & @JvmOverloads ABI",
  behavior: "Skips unknown future wire part keys, maps unrecognized harm and modality enums to UNKNOWN or UNSPECIFIED, decodes CitationMetadata publication dates, and exposes upstream Java static/overload signatures.",
  featureKeys: ["CitationMetadata", "HarmSeverity"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiJavaAbiAndCodecEdgeTest.kt`.",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiJavaAbiAndCodecEdgeTest.kt",
  ],
});
