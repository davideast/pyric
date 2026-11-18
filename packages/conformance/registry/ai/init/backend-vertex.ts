import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["VertexAIBackend"],
  api: 'VertexAIBackend',
  behavior: '`VertexAIBackend` carries `backendType` `VERTEX_AI`; its location and the resulting AI handle location default to `us-central1`',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#backend-vertex` (matches upstream constructor default)',
  conformanceTests: ['instances.test.ts'],
});
