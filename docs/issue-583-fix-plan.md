# Issue #583: preserve query-proof limitations through denial diagnostics

Analyzed 2026-09-07 at revision `952b4984` (`pyric` 0.1.0-alpha.22).
Issue: https://github.com/davideast/pyric/issues/583

## Recommendation

Fix diagnostic classification and attribution in this issue while keeping the current authorization decisions. Scope membership proof support as a separate follow-up. The demonstrated bug is diagnostic loss; a Firebase authorization mismatch for the application's complete ruleset has not been established.

This serves the Trust priority: users must distinguish a local proof limitation from an evaluated authorization denial. No production access, application rule changes, or new permission bypass is needed.

## Evidence

Built the current `pyric` package and ran an isolated, empty-store reproduction through both `LocalEnvironment.runQuery` and its query-listener path. The fixture includes the canonical nested collection, public visibility, limit 100, and optional recursive fallback `allow read, write: if false`.

| Rule status predicate | Query status constraint | Without fallback | With fallback |
| --- | --- | --- | --- |
| Equality to scheduled | Equality to scheduled | Allow | Allow |
| Equality to scheduled | `in` four statuses | Deny, missing equality explanation | Deny attributed to `false` |
| Membership in four statuses | Equality to scheduled | Deny, unsupported predicate explanation | Deny attributed to `false` |
| Membership in four statuses | `in` four statuses | Deny, unsupported predicate explanation | Deny attributed to `false` |

One-shot and listener outcomes agree. Denied listeners emit no snapshot. With fallback, both produce the issue's exact reasons: `No allow rules found for operation 'list'`, `Rule #0 (read,write) → deny`, and `Simulated: DENY`.

The temporary reproduction command `bun /tmp/pyric-583-repro.ts` exits 1 with `FAIL: fallback deny erases membership proof limitation from request events`. It checks loss of the existing predicate explanation on the listener event. This is an investigation harness, not a committed regression test.

Baseline validation:

```sh
bun run --cwd packages/pyric build
bun test packages/pyric/test/rules/simulator/query-proof.test.ts packages/pyric/test/firestore/sandbox/list-query-proof.test.ts packages/pyric/test/firestore/sandbox/rules-read-engine.test.ts packages/pyric/test/firestore/query-proof-enforcement.test.ts
```

Build passed; **101 tests passed, 0 failed**. Existing tests therefore do not catch this diagnostic regression. The full original application, Vite worker transport, and hosted Firebase were not exercised during this analysis.

## Root cause and contract

1. `packages/pyric/src/rules/simulator/query-proof.ts` deliberately rejects document-dependent membership and disjunctions. A constant `false` expression is document-independent and therefore *provable*: proof success does not mean residual evaluation allows it.
2. `packages/pyric/src/firestore/sandbox/list-query-proof.ts` collects rejected rules in `failures`, but its `provable` return carries only a projected AST and synthetic resource. If any sibling is provable, rejected-rule diagnostics are discarded. The fallback makes this branch run.
3. `packages/pyric/src/firestore/sandbox/rules-list-authorizer.ts` evaluates that projected AST. The unsupported membership rule has correctly been removed from authorization, so only the fallback remains to explain the denial. Re-evaluating the original AST would undo an intentional safety boundary documented in ADR-0009.
4. Even without fallback, the authorizer's early unprovable branch adds `proof.rule` to the error but omits attribution from the request event. Studio consumes request events, so fixing error text alone is insufficient.
5. `queryConstraintsForProof` in `query-execution.ts` accepts only scalar operands. It omits the array-valued `status in [...]` filter. This is intentional proof narrowing, but the reduced projection must not be presented as the complete application query.

The internal contract explicitly describes a conservative equality-only proof core. Some wording overstates it: the proof error says production rejects an out-of-scope query, and `packages/site-docs/src/content/secure/audit-your-rules.md` claims the sandbox enforces the same proof production does. Correct both.

Firebase documents authorization against potential results, rather than filtering stored documents. That principle does not establish equivalence between Firebase's proof capabilities and Pyric's limited proof engine. See [Firebase query authorization](https://firebase.google.com/docs/firestore/security/rules-query). No hosted parity conclusion follows from this reproduction.

## Implementation sequence

### 1. Preserve typed per-rule proof outcomes

Extend the internal proof result with explicit rejection categories: unsupported predicate/path shape versus missing or mismatched supported constraints. Do not infer categories by parsing English messages. Include the authored rule citation and expression, plus the unsupported subexpression when available. Helper-based rules should retain both the allow-site context and a useful predicate location.

Carry rejected-rule records alongside the projected AST on the `provable` branch as well as on total proof failure. Preserve all relevant failures in a deterministic order; do not let the first fallback or match order choose the only explanation. Keep the projected authorization AST and synthetic resource construction unchanged.

### 2. Combine proof and residual diagnostics after authorization

In `RulesListAuthorizer`, retain these cases distinctly:

- A provable sibling evaluates true: allow normally, even if other siblings are unsupported.
- No sibling grants and at least one proof is unsupported: deny locally with a primary proof-limitation explanation and the relevant rule. Retain residual denials as secondary evidence.
- Supported equalities are missing or mismatched: report those unmet constraints.
- A supported proof fails auth, limit, or another residual check: report residual evaluation failure.
- No applicable rule exists: retain the actual no-rule default denial.

Keep `permission-denied` and existing listener termination behavior. Do not turn a proof failure into `SimulatorUnsupportedError`, and do not change existing runtime-unsupported handling. Say that Pyric could not prove the query safe, not that Firebase has rejected it.

### 3. Carry one additive diagnostic payload end to end

Introduce an optional, serializable `queryProof` payload shared by `FirestoreSimError`, `DenialContext`, and `RequestEvent`. Include a primary category and per-rule evidence. Keep proof attribution separate from `evaluatedRule`: a predicate rejected statically did not evaluate to false and has no runtime expression trace.

Thread it through:

- `firestore/sandbox/errors.ts` and `request-events.ts`, including their explicit field-copying builders.
- `sandbox/admin-firestore/error-translation.ts` into `denialContext`; the modular `firestore/errors.ts` already forwards that context into FirebaseError custom data.
- CLI `serve/worker/protocol.ts` and `serve/worker/client/core.ts`, verifying both RPC errors and listener error frames retain the nested context.
- Sandbox event history and the `buildVerifyFixture` capture path used by `serve/worker/serve-init.ts`. The server's `capture-store.ts` stores JSON verbatim; change it only if a regression demonstrates a loss there.

Preserve complete query identity separately from the proof projection, using the existing executable/activity descriptor where available. Capture tests must assert the `in` filter and its existing bounded operand identity survive; do not expand proof acceptance just to improve diagnostics.

### 4. Attribute the limitation in Studio and document the boundary

Update `packages/studio/src/features/rules-debug/model.ts` and `RulesDebug.tsx` to consume proof diagnostics, show “Query proof unsupported,” and navigate to the authored relevant rule. Explain the local denial without manufacturing a false expression trace. Keep residual traces available as secondary information and continue accepting old captures with no new payload.

Update `secure/audit-your-rules.md` and, as appropriate, `trust/versioning-and-compatibility.md` with the supported proof subset, membership limitation, and local-versus-Firebase distinction. Update the canonical registry evidence as described below; a diagnostic-only fix does not close the membership divergence.

### 5. Update existing conformance evidence under CDD

`docs/conformance/cdd.md` requires claims to follow evidence, distinguishes unit-backed tests from oracle-backed replay, and requires two-sided pins for observed divergences. Its new-surface admission/climb machinery is not needed for this existing Firestore surface; the linked operational guide governs existing surfaces.

The canonical `packages/conformance/registry/firestore.ts` already contains:

- `firestore#24b`: query-proof enforcement, marked `conforms`, unit-backed.
- `firestore#24c`: conservative prover scope, marked `diverged-documented`, unit-backed. It explicitly lists membership, ranges, disjunctions, and other rejected shapes and says production may allow some of them.
- `firestore#139` and `firestore#139a`: rules-side proof and enforcement wiring, both unit-backed.

For this diagnostic fix, link the new membership/fallback regression tests from the relevant rows' evidence and `conformanceTests`, clarify local proof limitations in their wording, and correct stale wiring references in 139a where touched. Treat structured diagnostic assertions as Pyric's local contract, not Firebase's error-message contract. Keep 24c's divergence status and evidence tier; passing local tests supplies no new production observation. No new surface, climb lane, or status promotion is necessary.

Row 24c currently cites local tests rather than a production observation for this exact membership case. Preserve that uncertainty. The CDD divergence procedure cannot be satisfied for this case by inventing a production result or describing the local reproduction as oracle-backed evidence.

For a membership implementation, author a narrowly scoped claim and failing assertion set before implementation. Separate constant membership from the other limitations in 24c; do not turn the entire broad row green when only membership works. Capture an authorized production observation for the exact query/rules shape, pin both sides if they differ, and classify the observed gap as held, by-design, or pending-fix. Promote only the scoped claim after its unweakened assertion set passes, with the honest automation tier and applicable conformance checks. Any row split or status change must account for denominator effects and receive the repository's coverage-adversary review.

Regenerate projections with `bun run compat:generate`; do not edit generated COMPAT pages. Run `compat:validate`, `compat:audit`, and `compat:conformance:check`; run `compat:oracle-check` when observation-backed checks are involved. Investigate gate failures rather than weakening baselines.

## Regression and completion criteria

Add tests at the existing pure-proof, list aggregation, public modular listener, worker transport/capture, and Studio model seams. Use synthetic fixtures only.

- Equality control and membership variant, each tested with equality and actual `where('status', 'in', [...])` queries.
- Relevant rule plus recursive fallback in either source order. Assert category, authored expression/citation, event metadata, and application error context—not just `permission-denied`.
- Inline predicates, helper membership, and a synthetic `boundedList && (published || staff)` fixture. Treat the latter as diagnostic coverage, not proof of the original application's Firebase behavior.
- Missing visibility, forbidden status, unfiltered query, excessive limit, and failed identity residuals. Unsupported fixtures remain classified as unsupported; supported equality fixtures separately exercise constraint and identity categories.
- Unsupported sibling plus a genuinely allowing independent rule must still allow. Unsupported sibling plus false/auth-denied sibling must retain both pieces of evidence.
- Empty and populated stores produce the same authorization decision. Preserve existing tests against per-document filtering and placeholder-document authorization.
- Listener emits exactly one error, no successful snapshot, and terminates; worker error and event capture JSON round trips preserve diagnostics and the complete filter identity.
- Old captures render unchanged; Studio selects the membership rule for proof attribution rather than the fallback.

Run the four baseline suites above, new adapter/worker/capture/Studio tests, and affected package builds/typechecks. Then run required repository CI checks. No hosted test is required to validate this diagnostic fix.

## Separately scoped membership follow-up

Start with a constant finite-list predicate on a scalar document field. Equality queries require their value to belong to the allowed set; finite `in` queries require every possible value to belong. This is a candidate design, not an established Firebase compatibility claim.

The follow-up must address array operands in the proof representation and residual evaluation across every possible value. Picking one representative status would be unsound. Keep arbitrary document-dependent OR, dynamic lists, and document-dependent lookups out of the initial scope. Require explicit boundaries and appropriate Firebase parity evidence before claiming support; hosted testing requires separately authorized test-project access.

Application seed migration and CLI version reporting remain outside this fix.


## Implementation note

The activity-query contract deliberately uses bounded digests or opaque identities for operands. The fix preserves this representation rather than serializing raw executable operands, which could execute application getters or `toJSON` and change behavior. Public worker/capture regression coverage asserts that the `in` filter and its operand identity survive. A direct-engine regression asserts that diagnostic serialization does not observe a hostile operand.

## Completed validation

The diagnostic fix is implemented. Regressions cover the public modular read/listener paths, worker error frames, capture JSON, and Studio rendering. Existing top-level listener diagnostics remain available alongside FirebaseError custom data. Helper predicates retain their own citation (falling back to the helper declaration when expression locations are unavailable).

Validation: 10,665 offline workspace tests passed across the core, admin, scaffolder, CLI, template, UI, Studio, conformance, and repository-script suites. The CLI and remaining workspace suites required local socket access. Core package build and affected CLI/Studio/conformance typechecks passed. `compat:generate`, `compat:validate`, `compat:audit`, and `compat:conformance:check` completed successfully. Standards and spec reviews have no outstanding findings.

The initial full test command also attempted the three existing live parity suites; their 33 tests could not reach the production API. They were excluded from the subsequent offline run, without changing those tests or their expectations. No new hosted parity evidence is claimed.
