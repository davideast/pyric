import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'live-host',
  api: 'Auth.switchLens(_:)',
  behavior: 'Sets or clears an active impersonation AuthLens (.admin, .asUser, .anon).',
  featureKeys: ['switchLens'],
});
