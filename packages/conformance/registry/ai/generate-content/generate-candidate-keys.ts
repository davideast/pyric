import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate)',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope (candidateHasIndexOnWire) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-candidate-keys`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
