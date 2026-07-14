---
title: "Conformance scores"
group: "Conformance"
section: ""
order: 8001
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# Conformance scores

Pyric claims to mirror Firebase's observable behavior so you can develop against a sandbox and trust the swap. Conformance is the open receipt for that claim — not a parity badge. Three numbers answer three different questions. Do not fold them together.

## Surface coverage (total)

**Question:** How much of this Firebase package is here at all?

Numerator: runtime exports pyric re-exports. Denominator: every public runtime export of the upstream package (e.g. `firebase/auth`), including APIs pyric has written off and ones not built yet. If a call exists in the Firebase docs, this number says whether pyric even has a symbol for it.

## Surface coverage (intended)

**Question:** Against the contract pyric claims, how complete is the mirror?

Same numerator. Denominator drops only genuine `out-of-scope` symbols (Firebase-internal `_` plumbing, APIs pyric will not model). Deferred work — intended, not yet built — stays in the denominator as a gap, so planned-but-missing still lowers this number. Always ≥ total. This is the headline breadth number.

## Fidelity

**Question:** Of the claims pyric tracks in the compatibility matrix, how many match production Firebase?

This is the fidelity number, and it is the easiest to misread.

It is **not** "percent of Firebase that works." It is **not** surface coverage restated. It only scores rows that already appear in the per-service COMPAT matrix — discrete, named claims such as "sign-in with a wrong password throws `auth/wrong-password`" or "`getDocs` returns documents the signed-in user can read." Each row has a status:

<div class="compat-key">
</div>

**Numerator:** rows with status `conforms`. **Denominator:** every tracked row for that surface. Documented divergences, bugs, unsupported gaps, and unverified claims all lower the percentage — none are relabeled as success.

What a high or low number means:

- **High fidelity, low surface coverage** — a small slice is mirrored, and that slice mostly matches production. Breadth is the remaining risk.
- **High surface coverage, low fidelity** — many exports exist, but the matrix still carries divergences, unverified rows, or unfinished claims. Presence is not fidelity.
- **Fidelity never credits missing exports** — an API that is not in the matrix does not help or hurt this number. That gap belongs to surface coverage.

Read the matrix below the score on each COMPAT page for the concrete rows behind the percentage.

## Scores

| Surface | Surface coverage (total) | Surface coverage (intended) | Fidelity |
|---|---|---|---|
| App | 39.1% | 90% | 93.3% (14/15) |
| AI Logic | 69.1% | 80.9% | 92.3% (72/78) |
| Auth | 82.4% | 83.3% | 80.7% (96/119) |
| Firestore | 55.5% | 63.5% | 87.6% (141/161) |
| Realtime Database | 64.8% | 79.5% | 77% (154/200) |
| Storage | 48.1% | 72.2% | 83.8% (83/99) |
| Messaging | 100% | 100% | 100% (56/56) |
| Functions · RTDB | integration | integration | 0% (0/13) |
| Rules | native | native | 86.2% (50/58) |
| **Overall** | **64.1%** | **75.6%** | **83.4%** (666/799) |
