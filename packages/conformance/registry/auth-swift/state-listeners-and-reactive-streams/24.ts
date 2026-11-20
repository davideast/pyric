import { row } from './section.ts';

export default row({
  order: 110,
  flipped: 'live-host',
  api: 'Auth.idTokenPublisher',
  behavior: 'Exposes a Combine AnyPublisher emitting User? on ID token transitions.',
  featureKeys: ['idTokenPublisher'],
});
