import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["MessagingPayload"],
  flipped: 'unit-backed',
  api: 'interface MessagingPayload { data?; notification? }',
  behavior: 'Legacy combined payload — one or both of `data` / `notification` required.',
  evidence: 'Upstream typings (firebase-admin 13.10.0 `messaging-api`); no observation yet.',
});
