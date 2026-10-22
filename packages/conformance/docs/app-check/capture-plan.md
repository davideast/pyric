# App Check capture plan

Status: Step 1 of Conformance Driven Development (`docs/conformance/cdd.md`) for the `app-check` surface.
The surface is admitted at zero (`surfaces/app-check.json`, `registry/app-check.ts`, one row born `unverified`).
Every `app-check-` observation is parked in `exceptions/` until rows cite it.

## Why this surface

App Check will be mandatory for Firebase AI Logic.
Today `pyric/app-check` is a deferred stub that throws.
In production AI pass-through mode, `packages/cli/src/serve/firebase-module-swap.ts` still swaps `firebase/app-check` to that stub, so the real `firebase/ai` SDK never gets a token.
These captures pin what production does before any sandbox code is written.

## Project facts (read-only check, 2026-10-22)

| Fact | Value |
| --- | --- |
| Project | the dedicated oracle project, the same one `PYRIC_AI_FIREBASE_CONFIG` names |
| Web app | `ACTIVE`, display name `default` |
| reCAPTCHA v3 registration | none (no site secret set); `tokenTtl` 86400s |
| reCAPTCHA Enterprise registration | none (no site key); `tokenTtl` 3600s |
| Registered debug tokens | 0 before any run |
| App Check service for AI Logic | `firebaseml.googleapis.com` ("Firebase AI Logic" in the `services.patch` reference). `firebasevertexai.googleapis.com` is rejected: `Service not supported` |
| Enforcement, every listed service | `UNENFORCED` (database, data connect, AI Logic, storage, firestore, identitytoolkit) |

Because the web app has no reCAPTCHA registration, the browser captures attest only through a registered debug token.
The provider passed to `initializeAppCheck` is a `CustomProvider` whose `getToken` rejects: in debug mode the SDK never calls it, and a call would show up as a failed capture.

## Permissions (all granted to the oracle service account)

Names checked against the IAM reference for Firebase App Check (`firebaseappcheck.*`) with `projects.testIamPermissions`:

| Permission | Used by |
| --- | --- |
| `firebaseappcheck.debugTokens.get` | listing debug tokens for the stale-token sweep |
| `firebaseappcheck.debugTokens.update` | `projects.apps.debugTokens.create` and `.delete` (IAM has no separate create or delete permission) |
| `firebaseappcheck.tokens.mint` | Admin `createToken` (`projects.apps.exchangeCustomToken`) |
| `firebaseappcheck.appCheckTokens.verify` | Admin `verifyToken(token, { consume: true })` (`projects.verifyAppCheckToken`) |
| `firebaseappcheck.services.get` | reading enforcement mode |
| `firebaseappcheck.services.update` | the enforcement change (not run, see the last section) |
| `firebaseappcheck.recaptchaEnterpriseConfig.get`, `firebaseappcheck.resourcePolicies.get`, `firebaseappcheck.appAttestConfig.get` | configuration reads |

## Redaction rule

No observation stores a token, a debug token, a key, or an app id value.
A token is recorded by shape only: length, segment count, JOSE header field names and `alg`/`typ`, claim names, `iss` and `aud` with digits replaced by `<projectNumber>`, whether `sub` equals the config app id, and `exp - iat`.
Error messages are kept verbatim only after any token or app id substring is replaced with a placeholder.

## Observations

All are captured by `packages/conformance/src/app-check-probes.ts` (rig `rigs/app-check.ts`).
"No" in the enforcement column means the capture runs with every service `UNENFORCED`.

| Name | What it pins | How | Enforcement |
| --- | --- | --- | --- |
| `app-check-admin-create-token-shape` | `createToken(appId)` result keys, default `ttlMillis`, JWT shape and claim names, TTL from claims | firebase-admin `getAppCheck().createToken` | No |
| `app-check-admin-create-token-custom-ttl` | `ttlMillis` option honored (30 minutes), and the error for a TTL under 30 minutes and over 7 days | firebase-admin | No |
| `app-check-admin-create-token-unknown-app` | error envelope for an app id the project does not own | firebase-admin | No |
| `app-check-admin-verify-token` | `verifyToken` result keys, decoded claim names, `appId`; also verifying a client debug-exchange token | firebase-admin | No |
| `app-check-admin-verify-tampered` | error code and message for a token with a flipped signature and for a non-JWT string | firebase-admin | No |
| `app-check-admin-verify-consume` | replay protection: `verifyToken(t, { consume: true })` twice gives `alreadyConsumed` false then true | firebase-admin | No |
| `app-check-exchange-debug-token-wire` | raw REST envelope of `apps:exchangeDebugToken` for a registered token (`token`, `ttl`) and for an unregistered one (error envelope) | node fetch with the web API key | No |
| `app-check-client-debug-get-token` | `getToken` result keys, token shape, cache reuse on a second call, `forceRefresh` minting a new token | headless Chromium, real `firebase/app-check`, `self.FIREBASE_APPCHECK_DEBUG_TOKEN` | No |
| `app-check-client-limited-use-token` | `getLimitedUseToken` result keys, shape, whether it differs from the cached token, and whether it carries `jti` | Chromium | No |
| `app-check-client-on-token-changed` | listener and observer forms, call count across `getToken` and `forceRefresh`, argument keys, unsubscribe type | Chromium | No |
| `app-check-client-auto-refresh-toggle` | `setTokenAutoRefreshEnabled` return value and that it does not throw either way; `isTokenAutoRefreshEnabled` initial option | Chromium | No |
| `app-check-client-initialize-twice` | same options return the same instance; different options throw `appCheck/already-initialized` | Chromium | No |
| `app-check-client-get-token-before-initialize` | public `getToken` on an app that never called `initializeAppCheck`, and `initializeAppCheck` after `firebase/ai` already ran on the app | Chromium | No |
| `app-check-client-invalid-debug-token` | `getToken` with an unregistered debug token: resolves or rejects, `error` code and HTTP status, dummy token shape | Chromium | No |
| `app-check-client-ai-header` | the `X-Firebase-AppCheck` header the real `firebase/ai` SDK sends on `generateContent`: present, equal to `getToken`'s token, limited-use mode (`useLimitedUseAppCheckTokens`), absent without App Check, and what it sends when App Check fails | Chromium, request intercepted with Playwright `page.route` and continued | No |
| `app-check-ai-gate-wire` | AI Logic's gate on the wire from Node, in the `ai-probes` request shape: no header, malformed header, the SDK placeholder token, a tampered token, and a valid Admin-minted token; records the enforcement mode read at capture time | node fetch | No (see the finding below) |

## Finding: AI Logic already requires App Check on this project

With `firebaseml.googleapis.com` reading `UNENFORCED`, production AI Logic still rejects every `generateContent` that lacks a valid App Check token:
HTTP 403, `PERMISSION_DENIED`, message "Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check."
A malformed header, the web SDK placeholder token, and a tampered token get the same envelope; a valid token gets a 200.
So the rejection envelopes the original plan expected to need enforcement (`app-check-ai-enforced-no-token`, `app-check-ai-enforced-invalid-token`) are captured without an enforcement change, in `app-check-ai-gate-wire`, `app-check-client-ai-header` (`noAppCheck`), and `app-check-client-invalid-debug-token`.
The same 403 means the `ai-logic` rig (`ai-probes.ts`), which sends no App Check header, can no longer capture its success-path observations against this project.

What is still unobserved is whether `ENFORCED` mode changes the envelope (a different message or status once App Check is enforced). That is the only capture left that needs an enforcement change.

## Other production facts seen while capturing

- Admin `createToken` intermittently answers "App attestation failed." for a run of calls, then succeeds for the same app; the rig retries up to 8 times, 20 seconds apart. Seen in every run after the first, never on a lone call.
- In debug mode the web SDK never calls `onTokenChanged` listeners registered before the first `getToken`, even across forced refreshes; a listener added after a token exists is called once, asynchronously.
- With `useLimitedUseAppCheckTokens` and a failing attestation, `firebase/ai` throws `AI/error` before sending any request; without the option it sends the placeholder token and gets the 403.

## Run

```sh
bun --env-file=<repo>/.env packages/conformance/src/app-check-probes.ts
```

A run registers one debug token named `pyric-app-check-capture-<runId>` and deletes it in a `finally` block.
It first deletes any debug token whose display name starts with `pyric-app-check-capture-`, left over from an interrupted run, so it is safe to re-run.

## Enforcement step (proposal, not run)

Only one capture still needs it: `app-check-ai-enforced-envelope`, the same five requests as `app-check-ai-gate-wire` while `ENFORCED`, to learn whether the envelope changes.

- Turn on: `PATCH https://firebaseappcheck.googleapis.com/v1/projects/{project}/services/firebaseml.googleapis.com?updateMask=enforcementMode` with body `{"enforcementMode":"ENFORCED"}`, as the oracle service account (`firebaseappcheck.services.update`, granted).
- Duration: one capture run of a few minutes, plus propagation. App Check documents up to 15 minutes for enforcement changes, so poll the no-header request until its envelope stops matching the `UNENFORCED` one, with a 20-minute cap, then capture.
- What it affects while on: requests without a valid token are already rejected (see the finding above), so enforcing should not newly break the `ai-logic` rig. `.github/workflows/oracle-recapture.yml` deliberately excludes `ai-logic`, and `test/apps/ai-production-passthrough` answers Google from a Playwright route, so neither reaches the project. Any other client of this project's AI Logic outside this repo would see the enforced behavior; the project id suggests it may be shared, which only the owner can rule out.
- Revert: the same `PATCH` with `{"enforcementMode":"UNENFORCED"}`, then `GET .../services/firebaseml.googleapis.com` to confirm, and one no-header request to confirm the envelope matches `app-check-ai-gate-wire` again.
