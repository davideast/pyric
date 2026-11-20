import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseAuthPlatform.dispose()',
  behavior: 'Disposes platform resources, canceling bridge subscriptions and closing reactive stream controllers.',
  featureKeys: ['dispose'],
  flipped: 'unit-backed',
});
