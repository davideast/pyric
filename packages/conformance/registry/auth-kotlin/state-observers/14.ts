import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuth.addIdTokenListener(listener)',
  behavior: 'Registers an IdTokenListener invoked immediately on registration and whenever token or claims change.',
  featureKeys: ['addIdTokenListener', 'removeIdTokenListener'],
  flipped: 'live-host',
});
