import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['MessagingPayload'],
  flipped: 'type-backed',
  exceptionReason:
    'Pure TypeScript type definition exported from firebase-admin/messaging; legacy sendToDevice and sendToTopic methods were removed in firebase-admin v13, so no runtime carrier or production behavior exists to capture (closed structurally by TypeScript type assignability).',
  api: 'interface MessagingPayload { data?; notification? }',
  behavior: 'Legacy combined payload; one or both of `data` / `notification` required.',
  evidence:
    'Upstream typings (firebase-admin 13.10.0 `messaging-api`); pure TypeScript interface closed by structural type assignability.',
});
