import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["inMemoryPersistence","browserSessionPersistence","browserLocalPersistence","indexedDBLocalPersistence","browserCookiePersistence","browserPopupRedirectResolver","debugErrorMap","prodErrorMap"],
  api: "inMemoryPersistence / browserSessionPersistence / browserLocalPersistence / indexedDBLocalPersistence / browserCookiePersistence / browserPopupRedirectResolver / debugErrorMap / prodErrorMap",
  behavior: "Configuration tokens accepted by `initializeAuth(app, deps)` and `setPersistence(auth, persistence)`. The persistence tokens (`inMemoryPersistence`, `browserSessionPersistence`, `browserLocalPersistence`, `indexedDBLocalPersistence`, `browserCookiePersistence`) expose upstream `.type` discriminants (`NONE` / `SESSION` / `LOCAL` / `LOCAL` / `COOKIE`) and control session storage mode in both `initializeAuth` and `setPersistence`. `browserPopupRedirectResolver` is accepted and ignored because the sandbox provides `sandbox.setAuthFlowResolver`. `prodErrorMap` is accepted and deliberately not honored so sandbox errors retain diagnostic messages.",
  status: "diverged-documented",
  evidence: "Persistence tokens are enforced by `initializeAuth` and `setPersistence` (`unit:persistence-options.test.ts`, `unit:auth-session-persistence.test.ts`); `browserPopupRedirectResolver` and `prodErrorMap` remain documented inert tokens (`unit:types.test.ts`, `unit:sandbox-email-link.test.ts`). Oracle caveat recorded on auth#172: the `persistenceTypes` block of `auth-mechanical-surface-constants` reports `NONE` for every token including `browserLocalPersistence` -- a Node-build stub artifact, not the browser contract, so the `.type` values here follow the documented `Persistence.type` union instead.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/types.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts","packages/pyric/test/auth/sandbox/persistence-options.test.ts"],
});
