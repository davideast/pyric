import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["revokeAccessToken"],
  api: "revokeAccessToken(auth, token)",
  behavior: "Accepted no-op. In production this reaches OUTSIDE Firebase entirely — it tells the identity provider (in practice Apple) to revoke an OAuth access token, which is a call landing on Apple's servers. There is no external IdP behind a sandbox sign-in, so there is no token out there to revoke and nothing this call could truthfully do. It resolves (so the account-deletion flow Apple requires an app to ship runs end to end against the sandbox) and changes no sandbox state (because claiming otherwise would be a lie).",
  status: "diverged-documented",
  evidence: "`unit:types.test.ts` — the export resolves. Deliberately not oracle-probed: a successful probe would revoke a real token at a real IdP, which is a side effect on someone else's system that a conformance run has no business causing.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/types.test.ts"],
});
