import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.photoURL` / `user.phoneNumber` -- present (prod passes through, no longer stripped). A user created under a federated provider id (one containing a dot, such as `google.com`) with no photo of its own is assigned a generated `photoURL` at creation, matching prod, where a federated sign-in always returns one; `password`, `phone`, email-link, and anonymous users stay `null`. An identity-supplied photo always wins, and `phoneNumber` defaults to `null`. A served host stores the generated photo as a relative path in persisted state, seeds, captured sessions, and internal persistence snapshots, and reads it back absolute whenever an origin is known, as prod's always is: `user.photoURL`, `user.providerData[].photoURL`, wire `SerializedUser` payloads (including native bridge clients), the ID token `picture` claim, admin user records, blocking candidates, and Auth mutation events",
  status: "conforms",
  evidence: "`oracle:auth-user-photo-phone-and-provider-data` (fb-js-sdk 12.19.0: default `null` on anonymous/password users, configured `photoURL` and E.164 `phoneNumber` preserved); `unit:auth-user-methods.test.ts` (in-page + served worker); `unit:sandbox-provider-photo.test.ts`; `unit:served-avatar-origin.test.ts` (session user, `providerData`, token `picture`, admin records, Auth mutation events, native bridge fallback origin, and portable relative `exportUsers`); `test/apps/relative-avatar-photourl-blob-iframe`",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-photo-phone-and-provider-data"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/sandbox-provider-photo.test.ts", "packages/pyric/test/auth/auth-gap-surface.test.ts"],
  rowNumber: 58,
});
