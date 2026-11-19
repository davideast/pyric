import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Fires on token refresh (`getIdToken(true)`)",
  evidence: "`unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged` (NOT `onAuthStateChanged`, since identity is unchanged). Oracle: `packages/conformance/observations/auth/auth-onidtokenchanged-force-refresh.json` defines the target shape (`refreshFiredListener: true` against digame-mas; subscribe → null fire → `signInAnonymously` → +1 → `getIdToken(true)` → +1 for a total of 3 fires).",
  risk: ["specific-value","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-onidtokenchanged-force-refresh"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-token-refresh.test.ts"],
});
