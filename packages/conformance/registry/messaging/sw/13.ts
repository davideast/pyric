import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getMessaging","Messaging"],
  flipped: 'oracle-backed',
  api: 'getMessaging(app?): Messaging (sw)',
  behavior:
    'Returns the FCM instance within a service-worker context (bound to `getMessagingInSw`); registers under the component name `messaging-sw`.',
  evidence: 'oracle: `messaging-web-module-boundary-and-accessors.json` (`messaging-sw` per-app caching, separation from `messaging`, `app/no-app`, and post-`deleteApp` retention vs `app/app-deleted`). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-module-boundary-and-accessors'],
  tests: ['packages/cli/test/e2e/messaging-app-boundary.pw.ts', 'packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
  notes: 'The static-server witness imports the generated `/__pyric/sdk/*.js` entry URLs because native module workers do not inherit the page import map. Application source may use `firebase/messaging/sw` through the Vite/register bundler alias, just as production Firebase package imports require a build step.',
});
