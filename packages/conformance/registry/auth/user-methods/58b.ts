import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.providerId` (aggregate, `'firebase'`) + `user.providerData: UserInfo[]` — sandbox synthesizes one provider entry for non-anonymous users, empty for anonymous; prod passes the real array through (no longer stripped). The admin record carries the emulator-shaped `providerUserInfo`",
  status: "conforms",
  evidence: "`oracle:auth-user-photo-phone-and-provider-data` (fb-js-sdk 12.19.0: `providerId: 'firebase'`, `providerData: []` for anonymous, `uid === email` on `'password'` entry, `['password', 'phone']` when `phoneNumber` is assigned); `unit:auth-user-methods.test.ts` (in-page + served worker)",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["auth-user-photo-phone-and-provider-data"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/auth-gap-surface.test.ts"],
  rowNumber: 58,
});
