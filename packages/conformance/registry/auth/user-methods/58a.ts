import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.photoURL` / `user.phoneNumber` — present (prod passes through, no longer stripped). A user created under a federated provider id (one containing a dot, such as `google.com`) with no photo of its own is assigned a generated `photoURL` at creation, matching prod, where a federated sign-in always returns one; `password`, `phone`, email-link, and anonymous users stay `null`. An identity-supplied photo always wins, and `phoneNumber` defaults to `null`. A served host stores the generated photo as a relative path and reads it back absolute, as prod's always is: `user.photoURL` on the page's origin, and the ID token `picture` claim and admin user records on the origin the client signed in from",
  status: "conforms",
  evidence: "`oracle:auth-user-photo-phone-and-provider-data` (fb-js-sdk 12.19.0: default `null` on anonymous/password users, configured `photoURL` and E.164 `phoneNumber` preserved); `unit:auth-user-methods.test.ts` (in-page + served worker); `unit:sandbox-provider-photo.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-photo-phone-and-provider-data"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/sandbox-provider-photo.test.ts", "packages/pyric/test/auth/auth-gap-surface.test.ts"],
  rowNumber: 58,
});
