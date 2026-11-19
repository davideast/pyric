import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Registers a BLOCKING gate that runs before a real sign-in/sign-out transition commits. Callbacks run in registration order; a callback that throws (or returns a rejected promise) aborts the transition entirely: the pending `signInWith…`/`signOut` call rejects with `auth/login-blocked`, `currentUser` is unchanged, and `onAuthStateChanged`/`onIdTokenChanged` do NOT fire. Covers every sign-in path that exists in `pyric/auth`: `signInAnonymously`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `signInWithRedirect`, `signInWithCredential`, `signInWithCustomToken`, and `signOut`. Modeled after the real `@firebase/auth` `AuthMiddlewareQueue.runMiddleware` (`auth_impl.ts`), read directly from the installed SDK source, not just its `.d.ts`.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["error-code","listener","specific-value"],
  riskScore: 6,
  evidence: "`oracle:auth-beforeauthstatechanged-block-signin-and-signout` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page + served worker refusal pin); `unit:sandbox-before-auth-state-changed.test.ts`, `unit:upstream-auth-probes.test.ts`",
  riskReasons: ["asserts Firebase error code(s): `auth/login-blocked`","asserts listener semantics","asserts a specific value"],
  oracleObservations: ["auth-beforeauthstatechanged-block-signin-and-signout"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-before-auth-state-changed.test.ts","packages/pyric/test/auth/upstream-auth-probes.test.ts"],
});
