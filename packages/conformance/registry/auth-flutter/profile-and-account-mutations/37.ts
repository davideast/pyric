import { row } from './section.ts';

export default row({
  order: 40,
  api: 'UserPlatform.updateEmail(newEmail)',
  behavior: 'Updates user account email address via bridge RPC.',
  featureKeys: ['updateEmail'],
  flipped: 'unit-backed',
});
