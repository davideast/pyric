import { row } from './section.ts';

export default row({
  order: 50,
  api: 'UserPlatform.updatePassword(newPassword)',
  behavior: 'Updates user account password via bridge RPC.',
  featureKeys: ['updatePassword'],
  flipped: 'unit-backed',
});
