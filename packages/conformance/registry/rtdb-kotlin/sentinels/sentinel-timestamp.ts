import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'ServerValue.TIMESTAMP',
  behavior: 'Resolves server-side timestamp sentinel into current epoch milliseconds upon write.',
  featureKeys: ['serverTimestamp'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
