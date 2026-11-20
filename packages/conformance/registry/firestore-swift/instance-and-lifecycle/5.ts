import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Firestore.settings',
  behavior: 'Provides custom client configuration including host, sslEnabled, dispatchQueue, and cacheSettings.',
  featureKeys: ['settings'],
  flipped: 'unit-backed',
});
