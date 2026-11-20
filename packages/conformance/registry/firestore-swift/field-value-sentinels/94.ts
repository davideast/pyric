import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldValue.increment(_:)',
  behavior: 'Operand atomically incrementing numeric integer or double field value.',
  featureKeys: ['increment'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
