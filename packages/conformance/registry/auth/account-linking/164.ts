import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["linkWithPopup","linkWithRedirect"],
  api: "linkWithPopup(user, provider, resolver?) / linkWithRedirect(...)",
  behavior: "Route through the SAME `AuthFlowResolver` seam as `signInWithPopup`, with `authType: 'link'` on the request so a host UI can present 'link your Google account' rather than 'sign in'. The resolved credential names the provider to attach; the sandbox performs the attach and the uid is preserved. A disabled provider throws `auth/operation-not-allowed` AHEAD of the resolver check — a code deliberately distinct from `auth/argument-error`, which keeps meaning 'enabled, but no resolver/mock wired'.",
  evidence: "`unit:sandbox-linking-reauth.test.ts` — asserts the resolver sees `authType: 'link'`, the uid is preserved, and the two error codes stay distinct. The OAuth arm cannot be oracle-probed at all (it needs a real IdP popup and a human), which is precisely why it goes through the resolver seam.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
});
