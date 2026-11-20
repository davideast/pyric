import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'live-host',
  api: 'User.email',
  behavior: 'Returns the user\'s primary email address if available.',
  featureKeys: ['email'],
});
