import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Messaging"],
  flipped: 'oracle-backed',
  api: 'getMessaging(app?): Messaging',
  behavior:
    'Returns the FCM `Messaging` instance associated with the given (or default) `FirebaseApp`. Bound to the client component registered under the name `messaging`.',
  evidence: 'oracle: `messaging-web-module-boundary-and-accessors.json` (default vs named caching, `app/no-app`, post-`deleteApp` retention vs first-access `app/app-deleted`). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-module-boundary-and-accessors'],
  tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts', 'packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
});
