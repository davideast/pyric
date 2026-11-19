import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["NotificationMessagePayload"],
  flipped: 'unit-backed',
  api: 'interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] }',
  behavior: 'Legacy notification payload with localization keys, a `clickAction`, and arbitrary string keys.',
  evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
});
