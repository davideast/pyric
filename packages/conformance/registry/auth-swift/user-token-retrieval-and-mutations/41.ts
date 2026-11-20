import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'unit-backed',
  api: 'User.reload()',
  behavior: 'Refreshes user account data and custom claims from the Pyric backend asynchronously.',
  featureKeys: ['reload'],
});
