import { row } from './section.ts';

export default row({
  order: 20,
  diverged: 'by-design',
  api: 'onTokenChanged(appCheck, listener | observer)',
  featureKeys: ['onTokenChanged'],
  behavior: 'Production, debug mode: listeners and observers registered before the first `getToken` are never called, not by the first token, a forced refresh, or limited-use tokens. Sandbox: they are called once each time the cached token changes (the first token and every forced refresh), never for limited-use tokens, and not after unsubscribing, which is the upstream-documented behavior for an attestation provider.',
  evidence: 'capture `app-check-client-on-token-changed` (every `listenerCalls*` count is 0). The sandbox side and the attested-provider behavior are pinned in the suite; the attested-provider path is upstream-documented, not captured.',
  observations: ['app-check-client-on-token-changed'],
  notes: 'Divergence, by design: the sandbox has no attestation provider to stand in for, so it follows the documented provider path apps depend on rather than the debug-mode early return.',
});
