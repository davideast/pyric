import { row } from './section.ts';

export default row({
  order: 70,
  api: 'TransactionOptions.maxAttempts',
  behavior: 'Configures maximum retry attempts upon transactional concurrent contention.',
  featureKeys: ['transactionOptionsMaxAttempts'],
  flipped: 'unit-backed',
});
