---
title: "Conformance scores"
group: "Conformance"
section: ""
order: 8001
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# Conformance scores

Pyric claims to mirror Firebase's observable behavior so you can develop against a sandbox and trust the swap. Conformance is the open receipt for that claim — not a parity badge. Public runtime surface, public type surface, and fidelity answer different questions. Do not fold them together.

## Public runtime surface

**Question:** How much of this Firebase package is here at all?

Numerator: public Firebase runtime exports Pyric mirrors. Denominator: every non-underscore runtime export of the upstream package, including deprecated, unsupported, and not-yet-built APIs. Leading-underscore Firebase plumbing is private and is shown only in the raw diagnostic. Pyric-only helpers receive no credit.

## Public type surface

**Question:** How much of the exported TypeScript contract is present?

The TypeScript compiler reads the package declaration barrels and compares exported type names. Classes and enums participate in both namespaces because TypeScript exposes them as runtime values and types. This measures name presence, not structural assignability. Missing public types stay visible as gaps.

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

| Surface | Public runtime surface | Public type surface | Fidelity |
|---|---|---|---|
| App | 90% (9/10) | 66.7% (4/6) | 85.2% (23/27) |
| AI Logic | 69.1% (38/55) | 66.5% (109/164) | 92.3% (72/78) |
| Auth | 82.4% (70/85) | 39.1% (25/64) | 81.8% (99/121) |
| Firestore | 63.5% (66/104) | 38.5% (30/78) | 87.6% (141/161) |
| Realtime Database | 79.5% (35/44) | 53.3% (8/15) | 76.6% (154/201) |
| Storage | 72.2% (13/18) | 52.9% (9/17) | 86% (86/100) |
| Messaging | 100% (5/5) | 100% (8/8) | 100% (17/17) |
| Functions · RTDB | integration | integration | 92.3% (12/13) |
| Rules | native | native | 86.2% (50/58) |
| **Overall** | **73.5% (236/321)** | **54.8% (193/352)** | **84.3%** (654/776) |
