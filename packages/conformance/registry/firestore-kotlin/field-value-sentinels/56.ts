import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FieldValue.increment(value)',
  behavior: 'Encodes numeric transformation operand that atomically increments field value.',
  featureKeys: ['increment'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-crud-merge-sentinels-and-codecs'],
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
