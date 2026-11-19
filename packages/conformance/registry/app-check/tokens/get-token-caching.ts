import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck, forceRefresh?)',
  featureKeys: ['getToken'],
  behavior: 'A second `getToken` returns the cached token; `getToken(appCheck, true)` returns a different, newly minted token.',
  evidence: 'capture `app-check-client-debug-get-token` (`secondEqualsFirst`, `forceRefreshDiffersFromFirst`).',
  observations: ['app-check-client-debug-get-token'],
});
