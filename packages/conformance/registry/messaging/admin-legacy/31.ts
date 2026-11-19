import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["DataMessagePayload"],
  flipped: 'unit-backed',
  api: 'interface DataMessagePayload { [key]: string }',
  behavior: 'Legacy data payload — up to 4KB; the keys `from` and `google.*` are reserved.',
  evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
});
