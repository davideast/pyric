import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck, forceRefresh?) called concurrently',
  featureKeys: ['getToken'],
  behavior: 'Production, debug mode: concurrent `getToken` calls share one in-flight exchange, `forceRefresh` calls included: two calls started together with no cached token resolve to one token, and two forced calls started together resolve to one new token. Listener calls are row `app-check#on-token-changed-refresh`.',
  evidence: 'capture `app-check-client-get-token-concurrent` (`concurrentFirstShareOneToken`, `concurrentForcedShareOneToken`, `forcedDiffersFromFirst`). Upstream `getToken` in `@firebase/app-check` 0.11.3 starts an exchange only `if (!state.exchangeTokenPromise)`.',
  observations: ['app-check-client-get-token-concurrent'],
  notes: 'In debug mode the capture also records 0 listener calls after each pair, the debug-mode early return that row `app-check#on-token-changed-refresh` documents as a by-design divergence. The sandbox notifies listeners once per shared exchange, which a unit case in the suite pins.',
});
