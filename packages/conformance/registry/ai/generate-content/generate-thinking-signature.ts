import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["generateContent"],
  api: 'generateContent(request)',
  behavior: 'With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true`',
  automation: 'shape-backed',
  evidence: 'Capture ai-thinking-thought-parts (partKeySets, anyThoughtPart false) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-thinking-signature`',
  oracleObservations: ['ai-thinking-thought-parts'],
  conformanceTests: ['generate-content.test.ts'],
  notes: 'Lite models return signatures without thought parts; that is the captured fact.',
});
