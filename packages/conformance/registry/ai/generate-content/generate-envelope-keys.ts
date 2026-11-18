import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'The response envelope top-level key set is exactly `candidates`, `modelVersion`, `responseId`, `usageMetadata`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-envelope-keys`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
