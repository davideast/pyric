import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["inMemoryPersistence","browserSessionPersistence","browserLocalPersistence","indexedDBLocalPersistence","browserCookiePersistence","browserPopupRedirectResolver","debugErrorMap","prodErrorMap"],
  api: "inMemoryPersistence / browserSessionPersistence / browserLocalPersistence / indexedDBLocalPersistence / browserCookiePersistence / browserPopupRedirectResolver / debugErrorMap / prodErrorMap",
  behavior: "Inert configuration tokens, accepted so the idiomatic `initializeAuth(app, { persistence: indexedDBLocalPersistence })` and `setPersistence(auth, browserCookiePersistence)` compile, run, and behave identically. The `.type` discriminant matches upstream exactly (`NONE` / `SESSION` / `LOCAL` / `LOCAL` / `COOKIE`) because consumer code branches on it. `browserPopupRedirectResolver` is accepted and ignored — the sandbox has its own first-class pluggable equivalent (`sandbox.setAuthFlowResolver`). `prodErrorMap` is accepted and DELIBERATELY not honored: installing it upstream strips error messages, and doing that in a sandbox whose purpose is to tell a developer what went wrong would be actively hostile.",
  status: "diverged-documented",
  evidence: "In an in-memory sandbox the persistence CHOICE has no observable consequence, so accepting the token and recording the mode is the honest behavior — the same inert-token pattern `pyric/firestore` uses for its cache-factory tokens. `unit:types.test.ts` + `unit:sandbox-email-link.test.ts` cover the exports. Oracle caveat recorded on auth#172: the `persistenceTypes` block of `auth-mechanical-surface-constants` reports `NONE` for every token including `browserLocalPersistence` — a Node-build stub artifact, not the browser contract, so the `.type` values here follow the documented `Persistence.type` union instead.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/types.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
