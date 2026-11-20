import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseAuth.getInstance(app) / Firebase.auth(app)',
  behavior: 'Provides isolated FirebaseAuth instances distinguished by FirebaseApp.',
  featureKeys: ['getInstance'],
  flipped: 'live-host',
});
