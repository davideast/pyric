import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'setTokenAutoRefreshEnabled(appCheck, isEnabled): void',
  featureKeys: ['setTokenAutoRefreshEnabled'],
  behavior: 'Returns `undefined` and does not throw for either value; `getToken` still returns the cached token afterwards. Background refresh timing is not captured.',
  evidence: 'capture `app-check-client-auto-refresh-toggle`.',
  observations: ['app-check-client-auto-refresh-toggle'],
});
