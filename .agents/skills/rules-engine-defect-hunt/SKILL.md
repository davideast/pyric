---
name: rules-engine-defect-hunt
description: Surface map and gates for a defect hunt on pyric's own rules engines (RTDB, Firestore, Storage): the simulator, constraints DSL, deploy-time validator, security lint, sandbox enforcement, replay and coverage. Use with defect-hunt when the hunt targets rules tooling or a rules engine's parity with Firebase. Not for auditing an app's rules (use firestore-rules-audit or rtdb-security-rules).
---

# Rules engine defect hunt

The method (referees, verdicts, rounds, the fix campaign) is
[defect-hunt](../defect-hunt/SKILL.md). Load it first. This skill adds what is
specific to the rules engines: which surface to hunt with which angle against
which referee, and the gates in [references/pyric-gates.md](references/pyric-gates.md).

A rules engine that says allow where production says deny is the worst failure
pyric can have: the hole ships. Severity 1 is reserved for that.

## Surface map

| Surface | Referee | Angles that paid off | Pins |
|---|---|---|---|
| RTDB simulator (`simulate()`) | Production: [oracle-rtdb.md](../defect-hunt/references/oracle-rtdb.md) | Differential (grammar-guided expressions over `auth`, `data`, `newData`, `root`, `now`, mixed-type `==`, `null` operands, runtime errors inside `\|\|` and `&&`); structural cases (cascades, `.validate` on delete, wildcard vs literal siblings, multi-path updates) | `KNOWN_DIVERGENCES` |
| RTDB deploy-time validator and load check | Production deploy dry run | Differential: random rule documents through the dry run; regex dialect (`matches()` lookaheads, backreferences, `\b`, anchors, `\p{…}`) | `KNOWN_CORPUS_VALIDATOR_GAPS` |
| RTDB constraints DSL and builders | Contract (JSDoc, docs), then the deploy check | Contract sweep (falsy values, unknown keys, `undefined`); property fuzzing (compile never crashes or hangs, output passes the deploy check, no dependence on declaration order, parentheses kept for every operand shape) | conformance tests |
| RTDB security lint | The lint's documented intent; production for evaluation | A corpus of known-vulnerable patterns that must each fire; false positives on pyric's stdlib; constant folding (`true \|\| X` folds, `X \|\| true` does not absorb an error on the left) | lint tests |
| Firestore and Storage rules evaluation | Production: [oracle-rules-test-api.md](../defect-hunt/references/oracle-rules-test-api.md) | Differential over the corpus; the boundaries listed in that file | replay gates |
| Sandbox enforcement (transactions, listeners across auth and data changes, onDisconnect, priority, admin bypass) | Production SDK: [oracle-sdk-runtime.md](../defect-hunt/references/oracle-sdk-runtime.md); planes: [differential-planes.md](../defect-hunt/references/differential-planes.md) | Fault injection (revoke a read under an open listener, commit a transaction that changes readability); differential across planes | `rtdb-differential/known-divergences.ts`, oracle replay tests |
| Replay, coverage, trace | Contract, then the sandbox's own verdict | Metamorphic (replay re-decides the same verdict); coverage and mutation survivors | assurance tests |

The Firestore engine has no constraints DSL, so the DSL row does not apply
there; the contract sweep moves to the rules API, sandbox and index tooling.

## What a round found

The 2026-10-26 round on RTDB (#1247) confirmed 29 defects behind a 91/91
score: `matches()` running JavaScript RegExp where production uses its own
dialect, listeners not revoked after a transaction, a simulated `query` that is
`null` inside `.write`, DSL builders dropping falsy values, lint missing
tautologies and over-grants, and replay losing a transaction's priority. Look
there first for the shapes; check the umbrella issue's comments for what
turned up outside its streams.

## Gates

Run [references/pyric-gates.md](references/pyric-gates.md) at baseline, on
every stream branch, and on every PR branch tip.
