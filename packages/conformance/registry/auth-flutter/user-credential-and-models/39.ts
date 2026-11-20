import { row } from './section.ts';

export default row({
  order: 10,
  api: 'UserCredentialPlatform.user',
  behavior: 'Exposes UserPlatform instance resulting from successful authentication.',
  featureKeys: ['UserCredential'],
  flipped: 'unit-backed',
});
