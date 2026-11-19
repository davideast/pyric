import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "Rules see the session's minted ID token exactly: RTDB `auth.token` and Firestore and Storage `request.auth.token` carry every decoded claim with its value, `sub`, `aud`, `iss`, `iat`, `exp` and `auth_time` included (`iss` is `https://securetoken.google.com/` plus `aud`, `exp - iat` is 3600, `auth_time` stays the sign-in time across refreshes), claims the token lacks read null, and RTDB `auth.provider` equals `firebase.sign_in_provider`; per sign-in kind (anonymous, password, verified profile, custom token for a new or existing account, custom claims after a forced refresh, reload, updateProfile, password reauthentication, email link). Custom-token claims merge over the account's stored claims for that session only",
  status: "bug",
  statusNote: "Firestore and Storage drop the JWT claims (#1341); RTDB fills iat, exp and auth_time from the evaluation time; custom-token claims replace and persist; password reauthentication keeps sign_in_provider custom",
  evidence: "Production: `oracle:auth-request-auth-per-sign-in` (real sign-ins, RTDB probes deployed per decoded token) and `oracle:auth-request-auth-rules-test-api` (Firestore and Storage evaluating the same claim sets). In-page replay with pins: `unit:request-auth-per-sign-in.test.ts`",
  risk: ["specific-value"],
  riskScore: 3,
  riskReasons: ["asserts every decoded claim per sign-in kind in three engines"],
  automation: "oracle-backed",
  oracleObservations: ["auth-request-auth-per-sign-in", "auth-request-auth-rules-test-api"],
  conformanceDisposition: "pending-fix",
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/request-auth-per-sign-in.test.ts"],
});
