import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.setPersistence(persistence)',
  behavior: 'Configures session persistence mode across local storage or in-memory sessions.',
  featureKeys: ['setPersistence'],
  flipped: 'unit-backed',
});
