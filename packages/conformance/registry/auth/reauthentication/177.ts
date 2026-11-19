import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["reauthenticateWithPopup","reauthenticateWithRedirect"],
  api: "reauthenticateWithPopup(user, provider, resolver?) / reauthenticateWithRedirect(...)",
  behavior: "Route through the shared resolver seam with `authType: 'reauth'`. The identity the resolver produces MUST be the user being re-authenticated — a resolver that hands back a different uid throws `auth/user-mismatch`. That check is the entire security content of the flow; without it 're-authentication' would accept anyone.",
  status: "conforms",
  evidence: "`unit:sandbox-linking-reauth.test.ts` — asserts the resolver sees `authType: 'reauth'` and that an impostor identity is rejected with `auth/user-mismatch`.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/user-mismatch`"],
});
