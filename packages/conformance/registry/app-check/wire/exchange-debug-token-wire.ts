import { row } from './section.ts';

export default row({
  order: 10,
  api: 'POST projects/{projectId}/apps/{appId}:exchangeDebugToken?key=',
  featureKeys: ['getToken'],
  behavior: 'A registered debug token exchanges for `{ token, ttl: "3600s" }`; an unregistered one fails 403 `PERMISSION_DENIED` with message `App attestation failed.`',
  evidence: 'capture `app-check-exchange-debug-token-wire`.',
  observations: ['app-check-exchange-debug-token-wire'],
  errorText: true,
  unsupportedReason: 'The sandbox mints tokens in process and serves no App Check REST endpoint; no app calls the exchange directly.',
});
