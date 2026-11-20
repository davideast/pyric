import { row } from './section.ts';

export default row({
  order: 110,
  flipped: 'live-host',
  api: 'User.claims',
  behavior: 'Returns the dictionary of custom and standard claims associated with the user\'s ID token.',
  featureKeys: ['claims'],
});
