import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["generateContent"],
  api: 'generateContent(request)',
  behavior: 'A top-level `systemInstruction` is accepted and the response envelope shape is unaffected',
  automation: 'shape-backed',
  evidence: 'Capture ai-system-instruction-accepted replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-system-instruction`',
  oracleObservations: ['ai-system-instruction-accepted'],
  conformanceTests: ['generate-content.test.ts'],
});
