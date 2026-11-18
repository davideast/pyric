import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'Token counts are minted without a tokenizer, and the minimal envelope omits `safetyRatings`, matching the captured candidate key set',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-decoration-synthesized`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
  notes: 'Ruling 2 in packages/conformance/docs/ai/cdd-deltas.md: synthesized decoration is a standing by-design divergence class, documented per row and never hidden.',
});
