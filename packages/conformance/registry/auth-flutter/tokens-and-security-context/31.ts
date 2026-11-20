import { row } from './section.ts';

export default row({
  order: 20,
  api: 'UserPlatform.getIdTokenResult([forceRefresh])',
  behavior: 'Returns structured IdTokenResult containing decoded claims, expiration, and auth timestamps.',
  featureKeys: ['getIdTokenResult'],
  flipped: 'unit-backed',
});
