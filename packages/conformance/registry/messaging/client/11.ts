import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["onMessage"],
  flipped: 'oracle-backed',
  api: 'NextFn, Observer, Unsubscribe (re-exported from @firebase/util)',
  behavior:
    'The callback, observer, and teardown types consumed by `onMessage` / `onBackgroundMessage` are re-exported from `@firebase/util`.',
  evidence: 'oracle: `messaging-web-observer-and-unsubscribe.json` (`NextFn`, `Observer` `{ next, error, complete }`, and idempotent `Unsubscribe` across `onMessage` and `onBackgroundMessage`). Replayed in-page and over SharedWorker.',
  observations: ['messaging-web-observer-and-unsubscribe'],
  tests: ['packages/cli/test/serve/worker/oracle-captures/messaging-client-sw.test.ts'],
});
