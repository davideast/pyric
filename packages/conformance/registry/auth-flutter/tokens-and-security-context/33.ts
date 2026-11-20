import { row } from './section.ts';

export default row({
  order: 40,
  api: 'UserPlatform forced token refresh event dispatch',
  behavior: 'Dispatches auth change events across platform streams when token claims change upon forced refresh.',
  featureKeys: ['idTokenRefresh'],
  flipped: 'unit-backed',
});
