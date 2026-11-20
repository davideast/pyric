import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'live-host',
  api: 'User.phoneNumber',
  behavior: 'Returns the user\'s phone number if available.',
  featureKeys: ['phoneNumber'],
});
