import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'live-host',
  api: 'Auth.signInAnonymously(completion:)',
  behavior: 'Signs in as an anonymous user using a completion closure.',
  featureKeys: ['signInAnonymously'],
});
