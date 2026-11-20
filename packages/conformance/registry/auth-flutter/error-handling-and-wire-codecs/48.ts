import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Remote client session isolation',
  behavior: 'Isolates client auth state and token subscriptions to clientSessionId without mutating browser session.',
  featureKeys: ['sessionIsolation'],
  flipped: 'unit-backed',
});
