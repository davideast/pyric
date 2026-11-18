import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'The usageMetadata key set on a minimal text call is `candidatesTokenCount`, `promptTokenCount`, `promptTokensDetails`, `serviceTier`, `totalTokenCount`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-key-set`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
