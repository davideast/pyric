import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['NotificationMessagePayload'],
  flipped: 'type-backed',
  exceptionReason:
    'Pure TypeScript type definition exported from firebase-admin/messaging; legacy sendToDevice and sendToTopic methods were removed in firebase-admin v13, so no runtime carrier or production behavior exists to capture (closed structurally by TypeScript type assignability).',
  api: 'interface NotificationMessagePayload { tag?; body?; icon?; badge?; color?; sound?; title?; ...; [key] }',
  behavior: 'Legacy notification payload with localization keys, a `clickAction`, and arbitrary string keys.',
  evidence:
    'Upstream typings (firebase-admin 13.10.0 `messaging-api`); pure TypeScript interface closed by structural type assignability.',
});
