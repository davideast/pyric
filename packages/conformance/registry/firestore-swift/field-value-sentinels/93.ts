import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: 'FieldValue.delete()',
  behavior: 'Sentinel deleting target field during document update operation.',
  featureKeys: ['deleteField'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
