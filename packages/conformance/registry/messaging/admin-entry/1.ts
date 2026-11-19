import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Messaging"],
  flipped: 'oracle-backed',
  api: 'getMessaging(app?): Messaging',
  behavior: 'Returns the `Messaging` service for the default or given admin `App`.',
  evidence: 'oracle: `messaging-send-admin-entry-accessors.json` (default vs named app caching, `app/no-app`, `TypeError` guard, live dryRun send). Replayed by the conformance suite.',
  observations: ['messaging-send-admin-entry-accessors'],
});
