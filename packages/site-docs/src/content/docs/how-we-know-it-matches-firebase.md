---
title: "How we know it matches Firebase"
navLabel: "Conformance"
group: "Trust"
section: ""
order: 7001
description: "Understand the evidence behind \"it behaves like the real one,\" and what a divergence means when you hit one."
---

# How we know it matches Firebase

"Behaves like Firebase" is a claim anyone can make. Pyric's version is tested, not asserted, and this page shows you the machinery so you can decide how much to trust it.

## Recorded from production, replayed on every change

Probes run against a real Firebase project and record what actually happens: the error code a bad password returns, the shape a server timestamp resolves to, the way a query orders missing fields. The loop:

1. Each recording is committed as an observation.
2. CI replays every committed observation against the sandbox on every change.
3. If a change makes the sandbox answer differently than production did, the build fails before the change lands.

The observations are re-capturable, and the git diff of a re-capture is the drift report. An unchanged file means production still behaves as pinned. A changed file means the behavior moved, and the affected claims get reviewed.

When Pyric tells you how Firebase behaves, it is citing a recording, not repeating documentation.

## The matrices are the contract

Each service publishes a compatibility matrix: one row per behavior, each row carrying a status and the evidence that locks it. The rule that governs the whole system is short. **A documented divergence is a row. An undocumented divergence is a bug.**

There is no third category. A row marked diverged states both sides, the reason, and the test that pins both behaviors, so the difference cannot silently widen.

A mismatch with no row is a defect to report, and the fix's regression test already half-exists, because recording the divergence pinned both sides.

The matrices are generated from the evidence registry, never edited by hand, and the counts in them move as rows land, so read them directly rather than trusting a number quoted anywhere else:

- [Firestore](../pyric-firestore-compat/)
- [Auth](../pyric-auth-compat/)
- [Realtime Database](../pyric-database-compat/)
- [Storage](../pyric-storage-compat/)

## The rules engine has its own harness

Rules are where local-versus-production differences hurt most, so the rules simulator does not lean on the matrices alone. It keeps a corpus of rulesets, valid, invalid, and edge cases, each saved with its known outcome.

A parity harness runs that corpus against Google's hosted Rules Test API in CI. The same source goes to both engines, and the verdicts are compared. Building that corpus is also where much of Pyric's rules knowledge came from: you cannot save every variant with its known outcome without first discovering the outcomes.

You can run the same cross-check on your own traffic:
```bash
pyric verify --engine both --project my-app --rules firestore=firestore.rules
```
It sends your captured session through the local engine and the hosted one and flags any disagreement. See [Ship to production](../ship-to-production/).

## What a divergence means for you

If you hit behavior that differs from production, check the service's matrix first.

- A row means the difference is intentional, explained, and stable. Read the reason and decide whether it affects you.
- No row means you found a bug, and reporting it comes with a built-in guarantee: the fix will be pinned by an observation, so it cannot regress silently.

One honest boundary: this level of proof currently holds for Auth, Firestore, and Rules. Realtime Database and Storage work and are documented, but most of their behavior is not yet pinned to production observations. That difference has its own page: [What's experimental](../whats-experimental/).

## Where to go next

Read [What's experimental](../whats-experimental/) for the exact boundary, or put the claim under load yourself: run the app, break a rule, and compare the verdict against production's.
