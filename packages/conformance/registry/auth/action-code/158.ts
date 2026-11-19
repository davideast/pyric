import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["takeAuthMail"],
  api: "sandbox.takeAuthMail(auth) / sandbox.setAuthMailResolver(auth, resolver)",
  behavior: "The sandbox IS the mail server. Every send posts a real message (operation, recipient, single-use code, and the full action link) to an outbox; `sandbox.takeAuthMail` reads it — the program's substitute for a human opening an inbox. The mailed link round-trips through the public `isSignInWithEmailLink` / `parseActionCodeURL` unchanged, and its code is the code the redeemer accepts, so the round trip production cannot complete without a human closes in-process. An installed `AuthMailResolver` is additionally notified per message; a resolver that THROWS does not fail the send that produced it.",
  status: "conforms",
  evidence: "`unit:sandbox-email-link.test.ts` — sandbox-only driver (no `firebase/auth` counterpart; this is the seam that makes the family testable at all).",
  automation: "sandbox-only",
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-link.test.ts"],
  exceptionReason: "sandbox-only test driver — no firebase/auth counterpart to observe (the analog of sandbox.mockSignInResult for the email family)",
});
