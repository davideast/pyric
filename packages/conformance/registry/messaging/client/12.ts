import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["ErrorCode"],
  flipped: 'oracle-backed',
  api: 'const enum ErrorCode (client)',
  behavior:
    'Client failures surface as thrown `FirebaseError`s carrying one of the 18 documented `ErrorCode` values (`missing-app-config-values`, `only-available-in-window`, `only-available-in-sw`, `permission-default`, `permission-blocked`, `unsupported-browser`, `indexed-db-unsupported`, `failed-service-worker-registration`, `token-subscribe-failed`, `token-subscribe-no-token`, `token-unsubscribe-failed`, `token-update-failed`, `token-update-no-token`, `invalid-bg-handler`, `use-sw-after-get-token`, `invalid-sw-registration`, `use-vapid-key-after-get-token`, `invalid-vapid-key`). The enum itself is `@internal`, not a public export.',
  evidence: 'oracle: `messaging-web-client-error-codes.json` (`ErrorCode` `@internal` non-export plus `messaging/permission-blocked` and `messaging/invalid-sw-registration` `FirebaseError` rejections). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-client-error-codes'],
  tests: ['packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
});
