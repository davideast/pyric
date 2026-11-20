import { row } from './section.ts';

export default row({
  order: 100,
  flipped: 'unit-backed',
  api: 'Auth.authStatePublisher',
  behavior: 'Exposes a Combine AnyPublisher emitting User? on auth state transitions.',
  featureKeys: ['authStatePublisher'],
});
