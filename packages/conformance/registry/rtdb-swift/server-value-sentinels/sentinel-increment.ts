import { row } from './section.ts';

export default row({
  order: 20,
  api: 'ServerValue.increment(_:)',
  behavior: 'Atomically increments the numeric value at the target path by delta on the server.',
  featureKeys: ['serverIncrement'],
});
