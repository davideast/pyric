import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: 'A normal completion finishes with `finishReason` `STOP`',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-finish-stop`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
