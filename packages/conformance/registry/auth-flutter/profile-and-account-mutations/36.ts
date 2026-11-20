import { row } from './section.ts';

export default row({
  order: 30,
  api: 'UserPlatform.delete()',
  behavior: 'Deletes authenticated user account via bridge RPC and clears currentUser.',
  featureKeys: ['deleteUser'],
  flipped: 'unit-backed',
});
