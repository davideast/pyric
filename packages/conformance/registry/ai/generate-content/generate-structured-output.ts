import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["generateContent"],
  api: 'generateContent(request)',
  behavior: '`responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set',
  automation: 'shape-backed',
  evidence: 'Capture ai-structured-output-shape replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-structured-output`',
  oracleObservations: ['ai-structured-output-shape'],
  conformanceTests: ['generate-content.test.ts'],
  notes: 'The parsed key set is a shape fact; the JSON values are not claims.',
});
