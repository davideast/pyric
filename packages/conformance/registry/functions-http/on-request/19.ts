import { SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 190,
  kind: 'upstream',
  api: 'onRequest({ maxInstances, minInstances, concurrency, memory, cpu }, handler)',
  behavior:
    'Requests to one function run concurrently. maxInstances, minInstances, concurrency, memory, and cpu are deploy-time scaling options that pyric reads and does not apply: it has no instance model.',
  evidence:
    'upstream: these options only shape the deployed Cloud Run service (`__endpoint` fields read by firebase-tools at deploy).',
  flip: {
    status: 'unsupported',
    reason:
      'maxInstances, minInstances, concurrency, memory, and cpu size the deployed Cloud Run service; pyric runs one child per session with no instance model, so it serves every request concurrently and applies none of them. The assertion set pins concurrent serving, including for a maxInstances: 1 function.',
    tests: [SUITE],
  },
});
