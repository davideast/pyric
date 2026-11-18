import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'Candidate content carries role `model` and the content key set is `parts`, `role`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-role-model`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
