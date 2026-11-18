import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: '`modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-modelversion-responseid`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
  notes: 'Synthesized decoration (ruling 2 in packages/conformance/docs/ai/cdd-deltas.md); the values are minted, only presence and determinism are claims.',
});
