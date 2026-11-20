import { row } from './section.ts';

export default row({
  order: 10,
  api: 'UserPlatform.getIdToken([forceRefresh])',
  behavior: 'Retrieves valid JWT ID token string from bridge, forcing refresh when requested.',
  featureKeys: ['getIdToken'],
  flipped: 'unit-backed',
});
