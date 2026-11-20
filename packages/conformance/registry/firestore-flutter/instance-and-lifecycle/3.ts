import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFirestorePlatform.settings',
  behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes.',
  featureKeys: ['settings'],
  flipped: 'unit-backed',
});
