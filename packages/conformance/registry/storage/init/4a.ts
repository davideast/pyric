import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['getStorageSandbox'],
  behavior: 'Two `getStorageSandbox(sandbox)` calls on a bare `Sandbox` return the SAME wrapper (identity-stable)',
  status: 'conforms',
  automation: 'sandbox-only',
  evidence:
    'ST-B3 fixed: `withAuth(null)` mints a fresh context per call, so the per-context cache missed and bare-Sandbox calls returned different handles. A `Sandbox`-keyed cache makes the convenience path stable, matching the docstring. Probe: `unit:service.test.ts` ("ST-B3: returns the same handle for repeated bare-Sandbox calls").',
  conformanceTests: ['packages/pyric/test/storage/service.test.ts'],
  rowNumber: 4,
  exceptionReason:
    'Pyric-native bare-Sandbox handle caching on getStorageSandbox(sandbox); no firebase/storage counterpart exists.',
});
