import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "The credential's rich `User` (email / displayName / isAnonymous) survives the transition — popup/redirect/credential/`setUser` do NOT clobber it down to the bare `AuthState`; `cred.user === auth.currentUser` (reference identity, matches upstream `_updateCurrentUser(userCredential.user)`)",
  status: "conforms",
  evidence: "`unit:sandbox-user-identity.test.ts` (locks AUTH-B1)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-user-identity.test.ts"],
  rowNumber: 47,
});
