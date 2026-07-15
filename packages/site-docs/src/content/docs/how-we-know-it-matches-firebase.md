---
title: "How does Pyric know it works like Firebase?"
navLabel: "Conformance"
group: "Trust"
section: ""
order: 7001
description: "See the production evidence behind Pyric's conformance claims, the gaps those claims leave open, and the checks to make before shipping."
---

# How does Pyric know it works like Firebase?

If Pyric is a mirror of Firebase, how does it know it actually behaves like Firebase?

Documentation describes intent. TypeScript declarations describe shape. Neither records what a deployed Firebase project actually did. The strongest available evidence is Firebase itself, so Pyric captures production behavior, compares the local result, and publishes where the two agree and where they do not. That is what it means to conform.

The application call stays the same:
```ts
import { signInWithEmailAndPassword } from 'firebase/auth';
```
During Vite development, supported `firebase/*` imports resolve to Pyric. A production build resolves them to Firebase. Conformance asks whether the two implementations return the same value, error, state transition, or Rules verdict for a defined behavior.

## The conformance system

One behavior moves through five connected steps:

<div class="conformance-flow">
<div class="flow-step">Production Firebase</div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Capture evidence<span class="flow-sub">observation or Rules corpus</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Register the claim<span class="flow-sub">status and evidence</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Check Pyric<span class="flow-sub">tests and conformance gates</span></div>
<div class="flow-arrow" aria-hidden="true">→</div>
<div class="flow-step">Publish the result<span class="flow-sub">generated matrices</span></div>
</div>

The observation records what Firebase did. The registry states the claim Pyric makes about that behavior. A local check determines whether Pyric matches the recorded result. Generated matrices expose the status and its evidence directly from those sources.

## Follow one behavior from Firebase to the matrix

Consider a failed password sign-in. A probe signs into a real Firebase project with the wrong password and records the result, including the Firebase SDK version and project used for the capture:
```json
{
  "name": "auth-wrong-password-error-code",
  "rowIds": ["auth#15"],
  "fbSdkVersion": "12.13.0",
  "projectId": "blockingfun",
  "behavior": {
    "code": "auth/wrong-password",
    "messageContains": {
      "wrongPassword": true,
      "invalidCredential": false
    }
  }
}
```
That committed [observation](https://github.com/davideast/pyric/blob/main/packages/conformance/observations/auth/auth-wrong-password-error-code.json) is a captured fact, not a summary of Firebase documentation. It is then attached to a specific registry row:
```ts
{
  id: 'auth#15',
  api: 'signInWithEmailAndPassword(auth, email, password)',
  behavior: 'Throws auth/wrong-password when the password does not match',
  status: 'conforms',
  oracleObservations: ['auth-wrong-password-error-code'],
  conformanceTests: ['packages/pyric/test/auth/sandbox-email-password.test.ts'],
  automation: 'oracle-backed',
}
```
The [registry row](https://github.com/davideast/pyric/blob/main/packages/conformance/registry/auth.ts) is the published claim. It names the production evidence, the broader local behavior test, the current status, and the strength of the automation behind it.

Separately, an [oracle conformance test](https://github.com/davideast/pyric/blob/main/packages/pyric/test/auth/oracle-conformance.test.ts) reads the observation and requires Pyric to return the recorded error code:
```ts
const observation = load('auth-wrong-password-error-code.json');

await expectCode(
  signInWithEmailAndPassword(auth, 'wp@example.com', 'wrong9999'),
  observation.code,
);
```
CI checks this chain in layers. Registry validation rejects missing or inconsistent evidence references. The library tests exercise local behavior, including observation-backed comparisons like this one. Selected production observations also have dedicated replay checks. The generated matrices are rendered from the model on a clean checkout; the docs build renders them twice and verifies deterministic output, routes, Markdown/HTML twins, and links.

This distinction matters. `compat:check` validates the conformance model and generated results, but it does not replay every production observation by itself. The full CI suite combines those gates with the tests that exercise Pyric.

## Security Rules require a corpus

A single API result can be captured as one observation. Security Rules need a broader method because a ruleset is a program. The relevant question is whether Firebase allows or denies a request under a particular ruleset, data state, identity, and operation.

The [Rules corpus](https://github.com/davideast/pyric/tree/main/packages/conformance/rules-corpus) stores those inputs as scenarios. For example, Firestore treats direct access to a missing map field as a runtime error. Comparing that field with `null` denies the request, while the `in` operator performs an actual absence check:
```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /typoEqNullDeny/{id} {
      allow create: if request.resource.data.typo == null;
    }

    match /notInAllow/{id} {
      allow create: if !('typo' in request.resource.data);
    }
  }
}
```
The corpus expects the first request to be denied and the second to be allowed. Firebase supplies the authoritative verdict. Pyric's simulator must reach the same result.

Firestore and Storage expose hosted Rules Test APIs, so their capture runners can ask Firebase for each verdict directly. Realtime Database has no equivalent API. Its runner deploys each scenario's rules to a dedicated oracle database, executes the live operations in an isolated namespace, records the results, restores the previous rules, and verifies cleanup. The acquisition paths differ, but the contract is the same: production decides the expected verdict.

Committed Rules observations are replayed locally against the matching corpus scenarios. A mismatch remains visible as a documented divergence or bug until the simulator agrees.

## Public surface and behavior answer different questions

Behavior evidence cannot show whether an API is missing. A perfect match on a small set of calls would still leave a poor mirror if Firebase exposed much more.

The public-surface census therefore reads Firebase's public exports and compares them with Pyric. Runtime values and exported type names are measured separately. A runtime export counts unless its exact name is reviewed as private in that surface's authored contract; a leading `_` never classifies it automatically, so a new name fails closed as an unmapped gap. The type-name census still excludes leading-underscore names by its structural rule while type classification remains future work. Unsupported or deprecated public APIs stay in the denominator, and Pyric-only helpers receive no credit.

The census proves name presence, not signature equivalence or runtime behavior. Those questions belong to types, tests, and registry evidence. Keeping the axes separate prevents a strong result on one axis from hiding a weak result on another.

The current [conformance scoreboard](https://pyric.dev/docs/pyric-conformance-scores/) publishes public runtime surface, public type surface, and behavior fidelity separately.

## Five states keep the gaps visible

Every tracked behavior has one of five states:

| State | Meaning |
|---|---|
| **Conforms** | The tracked behavior matches Firebase at the stated level of evidence. |
| **Documented divergence** | Firebase and Pyric intentionally differ, with both behaviors and the reason recorded. |
| **Bug** | Pyric should match Firebase but currently does not. |
| **Unsupported** | The behavior is outside the current implementation. |
| **Unverified** | The behavior is tracked, but the available evidence does not yet establish the result. |

Status and evidence strength are separate. A conforming row may be backed by a production observation, a shape capture, a local test, or a narrower source of evidence. The matrix shows that distinction rather than treating every green row as equally proven.

The registry is also a tracked behavior set, not an inventory of every behavior Firebase could exhibit. Missing from the registry does not mean passed. It means no claim is being published for that behavior yet.

## What this proves, and what it does not

Conformance is a floor, not a guarantee of total equivalence.

- **Evidence covers defined claims.** A production observation supports the rows connected to it. It does not generalize to adjacent behavior that was never captured.
- **Observations are snapshots.** Each records an SDK version and project configuration. Configuration-dependent behavior can remain unknown until the right project and probe exercise it.
- **The behavior registry is incomplete by design.** It contains the claims currently tracked. Firebase behavior outside that set is not silently counted as conforming.
- **Evidence is uneven.** Some rows are pinned directly to production. Others have local, type-level, or sandbox-only evidence. The matrices expose that strength row by row.
- **Surface evidence is name-level.** The census can establish that a public runtime or type name exists. It does not prove the full signature, semantics, or interaction with other APIs.
- **A local mirror cannot remove the production boundary.** Project configuration, deployed Rules, credentials, service state, and Firebase changes still require controlled verification before release.

No published result is typed into this page. Registry state and the live public-surface census generate the matrices and scoreboard. CI verifies the model gates and proves those pages render deterministically from a clean checkout with valid routes, twins, and links.

## Verify the boundary before shipping

Pyric is designed for local development, where operations have no production consequences. Before deployment, replay the captured development session against the candidate Rules:
```bash
npx pyric verify
```
The default engine runs locally and requires no cloud credentials. For Firestore, the hosted Rules Test API can provide a second verdict from Google in a controlled project:
```bash
npx pyric verify --engine both --project staging-project
```
Hosted verification evaluates derived cases. It does not deploy Rules or modify production data. It does require Firebase credentials and a project configured for that check.

This is the final boundary of the conformance claim. Pyric supplies evidence that local behavior matches the cases it tracks. A staging or hosted verification step checks the application-specific configuration that a general conformance suite cannot know. Then the same `firebase/*` application code can proceed through the normal Firebase deployment path described in [Ship to production](../ship-to-production/).

The generated matrices contain the current evidence for [App](https://pyric.dev/docs/pyric-app-compat/), [Auth](https://pyric.dev/docs/pyric-auth-compat/), [Firestore](https://pyric.dev/docs/pyric-firestore-compat/), [Realtime Database](https://pyric.dev/docs/pyric-database-compat/), [Storage](https://pyric.dev/docs/pyric-storage-compat/), [Messaging](https://pyric.dev/docs/pyric-messaging-compat/), [AI Logic](https://pyric.dev/docs/pyric-ai-compat/), [Security Rules](https://pyric.dev/docs/pyric-rules-compat/), and [Functions with Realtime Database](https://pyric.dev/docs/pyric-cli-functions-rtdb-compat/).
