import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Transaction retry mechanism',
  behavior: 'Catches optimistic locking conflicts and re-executes handler up to maxAttempts.',
  featureKeys: ['runTransaction'],
});
