import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["Messaging"],
  flipped: 'oracle-backed',
  api: 'Messaging.get app(): App',
  behavior: 'The admin `App` this `Messaging` instance is bound to.',
  evidence: 'oracle: `messaging-send-admin-entry-accessors.json` (`Messaging.app` matches the bound default or named `App`). Replayed by the conformance suite.',
  observations: ['messaging-send-admin-entry-accessors'],
});
