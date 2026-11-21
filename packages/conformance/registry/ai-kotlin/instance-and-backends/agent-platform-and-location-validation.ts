import { row } from './section.ts';

export default row({
  order: 40,
  api: "GenerativeBackend.agentPlatform(location) / InvalidLocationException",
  behavior: "Configures GenerativeBackend.agentPlatform(location) defaulting to global and rejects blank or slash-containing backend locations with InvalidLocationException.",
  featureKeys: ["GenerativeBackend.agentPlatform", "InvalidLocationException"],
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt` (generativeBackendValidatesLocationsAndNormalizesModelResourceNames).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/ai/FirebaseAiInstanceAndDslTest.kt",
  ],
});
