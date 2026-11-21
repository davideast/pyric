import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "content { ... } / InlineDataPart / FileDataPart / GenerateContentResponse.inlineDataParts",
  behavior: "Encodes binary InlineDataPart (full 256-byte spectrum) and FileDataPart attachments with defensive byte copies and decodes returned inlineDataParts.",
  featureKeys: ["content", "InlineDataPart", "FileDataPart", "GenerateContentResponse.inlineDataParts"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/InlineDataAndMultimodalRoundTripTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostHardeningConformanceTest.kt` (multimodalInlineDataRoundTripsFullByteSpectrumAgainstLiveHost).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/InlineDataAndMultimodalRoundTripTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostHardeningConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
