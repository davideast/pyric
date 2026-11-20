import { row } from './section.ts';

export default row({
  order: 70,
  api: 'getReference(".info") / getReference(".info/serverTimeOffset")',
  behavior: 'Served locally: `.info` is `{ connected, serverTimeOffset }`, `serverTimeOffset` is 0, and any other path under `.info` is null.',
  featureKeys: ['infoRoot', 'serverTimeOffset'],
  status: 'diverged-documented',
  statusNote: 'the offset is always 0: the bridge handshake carries no server timestamp, and production delivers no offset until its first handshake; Android\'s `.info/authenticated` is not served',
});
