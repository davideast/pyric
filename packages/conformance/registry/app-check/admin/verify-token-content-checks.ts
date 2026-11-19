import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'getAppCheck().verifyToken(token, options) with bad input, on another project, or with a foreign issuer, algorithm, subject, key, nbf, or exp',
  featureKeys: ['verifyToken'],
  behavior: 'Options that are not a non-null object throw `app-check/invalid-argument` with `VerifyAppCheckTokenOptions must be a non-null object.`, and a token that is not a string throws `App check token must be a non-null string.`; both throw synchronously. Then, with no project id configured, `app-check/invalid-credential`. A token with a character outside base64url in any segment fails with the decoding message. Before the signature, the token content is checked in this order: a header `alg` other than RS256 rejects with `The provided App Check token has incorrect algorithm. Expected "RS256" but got "<alg>".`; an `aud` without `projects/<projectId>` of the verifying app rejects with `app-check/invalid-argument` and `The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/<projectId>" but got "<aud>". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`; an `iss` not starting with `https://firebaseappcheck.googleapis.com/` rejects with `The provided App Check token has incorrect "iss" (issuer) claim.`; a `sub` that is not a string rejects with `The provided App Check token has no "sub" (subject) claim.`, and an empty one with `The provided App Check token has an empty string "sub" (subject) claim.`',
  evidence: 'capture `app-check-admin-verify-token-content-checks` (`optionsNull`, `nonStringToken`, `missingProjectId`, `invalidBase64UrlSegment`, `wrongAlgorithm`, `wrongAudience`, `wrongIssuer`, `missingSub`, `nonStringSub`, `emptySub`), replayed in `packages/pyric-admin/test/app-check/oracle-conformance.test.ts`; post-signature `kid`, `nbf`, and non-numeric `exp` checks (`jsonwebtoken` `verify.js`) are pinned in `packages/pyric-admin/test/app-check/verify-upstream.test.ts`.',
  observations: ['app-check-admin-verify-token-content-checks'],
  errorText: true,
  notes: 'After content checks, a token with no `kid` is checked against every sandbox key; a foreign `kid` routes to row `verify-token-firebase-token` or `verify-token-firebase-token-production-ai-mode`; and post-signature non-numeric or future `nbf` and non-numeric `exp` reject as an invalid signature.',
});
