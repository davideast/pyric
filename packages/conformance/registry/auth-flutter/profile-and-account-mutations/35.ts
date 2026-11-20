import { row } from './section.ts';

export default row({
  order: 20,
  api: 'UserPlatform.reload()',
  behavior: 'Fetches latest user profile from bridge and updates active currentUser.',
  featureKeys: ['reload'],
  flipped: 'unit-backed',
});
