import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["Schema"],
  api: 'generationConfig.responseSchema',
  behavior: 'A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output',
  automation: 'shape-backed',
  evidence: 'Capture ai-structured-output-shape replayed by packages/pyric/test/ai/helpers-schema.test.ts test `ai#schema-rides-request`',
  oracleObservations: ['ai-structured-output-shape'],
  conformanceTests: ['helpers-schema.test.ts'],
});
