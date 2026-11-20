import { row } from './section.ts';

export default row({
  order: 70,
  api: 'reference(withPath: ".info") / reference(withPath: ".info/serverTimeOffset")',
  behavior: 'Served by the client: `.info` is { connected, serverTimeOffset }, and `serverTimeOffset` is 0.',
  featureKeys: ['infoRoot', 'serverTimeOffset'],
  status: 'diverged-documented',
  statusNote: 'the offset is always 0: the bridge handshake carries no server timestamp, and production delivers no offset until its first handshake',
  evidence: 'FirebaseDatabase Swift specification and ADR-0019 (amendment of 2026-10-16). The test asserts both values, null for another `.info` key, and that none reaches the worker.',
});
