import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseFirestore snapshot re-subscription',
  behavior: 'Active Firestore snapshots() flows automatically re-subscribe when CredentialsProvider emits a new AuthLens.',
  featureKeys: ['snapshots', 're-subscribe'],
  flipped: 'live-host',
});
