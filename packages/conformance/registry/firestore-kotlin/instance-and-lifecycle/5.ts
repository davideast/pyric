import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseFirestore.collection(path)',
  behavior: 'Instantiates a CollectionReference pointing to the slash-delimited path.',
  featureKeys: ['collection'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
