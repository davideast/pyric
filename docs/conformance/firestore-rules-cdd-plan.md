# Firestore Security Rules conformance climb

Status: executed locally on 2026-07-21 under the explicit-classification exit contract below (no PR, push, or remote CI)

Baseline date: 2026-07-21  
Initial analysis main commit: `564ab7ad`  
Final local execution base: `3011b4cc` (latest `main` on 2026-07-21)

## Execution result

The local execution reached a canonical strict score of **129/140 (92.1%)** and
ordered-universe SHA-256
`c096e0fd13900b095ffdfe235da72e5dd6a1a7f469ef91bb90ad878eaff4b03a`.
The denominator remained 140 throughout the climb.
All 28 Firestore observations are now bound to the exact production rules and
case-label-to-request mapping by SHA-256, and both the canonical score
computation and oracle replay require that digest plus the complete case-key
set to match. Editing a scenario without a production recapture therefore
removes its evidence credit and fails the exact score gate. Production
acceptance is independently bound to the current per-construct microprobe by a
second digest; stale acceptance labels receive no score credit.
Accepted constructs also require the exact production and local microprobe
verdicts to match the authored expectation. A missing or extra API result
aborts at the wire adapter before positional normalization. The committed
Firestore acceptance-evidence ledger preserves capture metadata and every
expected/actual verdict; score computation binds it to the compact snapshot
and current probe digest. The gate also binds the captured expected verdict to
the current canonical probe case, binds rejection/unprobeable diagnostics
exactly, and runs on both the standalone score command and the central
conformance-model projection path.

| Final classification | Constructs | Interpretation |
|---|---:|---|
| Conformant | 129 | Acceptance parity and production-backed behavior both match without contamination |
| Diverged | 2 | `getAfter` / `existsAfter`; retained as a documented Rules Test API probe limitation because the official atomic-write contract and local batch tests require the modeled behavior |
| Unknown | 0 | No accepted construct remains without a primary classification |
| Acceptance mismatch | 6 | Production rejects the minimal probe while the local evaluator currently accepts it |
| Local error | 0 | No accepted construct currently errors in the local microprobe |
| Unprobeable | 3 | Import, get-budget, and type-dispatch retain explicit unprobeable reasons and remain in the denominator |

The hill climb fixed rows #161, #165, #166, #167, #171, and #173, captured
positive and negative byte/hash representation witnesses plus
`duration.seconds()`/`duration.nanos()` evidence, and tightened the oracle so a
row cannot claim conformance by returning `UNSUPPORTED`. Row #174 now has
paired production witnesses proving that `Map.keys()` is a List while explicit
`toSet()` receivers implement Set algebra with Set arguments. The committed score baseline compares the full
per-construct fact set and ordered ID manifest, so any future movement requires
an explicit baseline update. Three production-rejected resource-identity probes
also receive credit because the local minimal probes reject at the same
evaluation boundary and their production-backed behavioral rows are verified.
Row #187 adds a dedicated four-case hierarchical-match witness so that semantic
is credited by an exact child ALLOW plus parent, sibling, and over-deep DENY
controls, rather than by generic nested syntax. The score command now replays
all production observations before evaluating its exact baseline.
The final cold-review ratchet also exposed and fixed numeric Set membership:
`toSet()` now preserves Rules values and deduplicates by Rules value equality,
so the three production-ALLOW `Set.hasAll`/`hasAny`/`hasOnly` probes agree
locally without conflating numeric `1` and string `'1'`.

Execution exposed two limits in the proposed phase exits, so completion uses
the plan's final explicit-classification contract rather than pretending those
limits are fixes. The production Rules Test API returns `Function not found`
diagnostics for every `getAfter`/`existsAfter` case; it cannot express an atomic
batch projection, while the documented contract and local batch tests require
that behavior. Earlier Set-algebra failures were receiver/argument type errors,
not an oracle limitation: `Map.keys()` returns a List, and
`set.difference(list)` is invalid. Explicit `toSet()` receivers with Set
arguments provide positive production witnesses for difference, union, and
intersection; the observation retains both sides of that boundary.

This plan applies Conformance Driven Development (CDD) to the existing
Firestore Rules surface. Unlike a new CDD surface, Firestore Rules already has
an implementation, a 140-construct language inventory, 27 production-captured
corpus scenarios, and 27 registry rows. The climb therefore starts by making
the current debt measurable rather than by admitting an empty surface.

## Initial baseline and the provisional score

The current reports answer different questions and must remain separate:

| Axis | Current result | Meaning |
|---|---:|---|
| Registry fidelity | 20/27 rows conforming (74.1%) | Seven behavior rows are known divergences. Row weighting is uneven, so this is not language coverage. |
| Production evidence | 107/140 constructs verified (76.4%) | 22 constructs are contaminated by known divergences and 11 lack production evidence. |
| Local capability | 131 implemented, 3 unsupported, 3 errors, 3 unprobeable | The published 97.8% is 131/134 and excludes errors and unprobeable constructs; it is not a conformance score. |
| Strict assurance proxy | 103/140 supported (73.6%) | The shared conformance graph currently classifies another 5 as qualified and 32 as unsupported. |

Until the computation below lands, use **103/140 (73.6%)** as the conservative
estimate of Firestore Security Rules conformance. Publish the fraction with the
percentage. Do not publish the stale 91.4% figure as conformance: it predates
divergence contamination and describes evidence breadth, not trustworthy local
behavior.

The 73.6% value is still a proxy. In particular, the current graph treats a
production-rejected construct as unsupported rather than asking whether Pyric
rejects it in the same phase and with the same observable result. That prevents
the current model from representing acceptance conformance precisely.

## Current gaps

### Known divergences: fix before filling low-risk evidence gaps

These seven rows contaminate 22 constructs. Six rows contain local false-ALLOW
cases, which can make a local rules check look less restrictive than production.

1. `firestore-rules#165` — mocked `get()` results synthesize `id` and
   `__name__`; production leaves both absent. Four constructs are scoped to the
   row. This is direct access-control risk and the first fix.
2. `firestore-rules#164` — `getAfter()`/`existsAfter()` post-write behavior
   differs on create, delete, target identity, and unrelated paths. Two
   constructs; high impact for atomic-write invariants.
3. `firestore-rules#166` — an empty `request.query` is modeled as an empty map
   locally where production denies the comparison. One construct.
4. `firestore-rules#161` — `toUtf8`, byte helpers, and four hashes false-ALLOW
   five captured cases. Eight constructs and the largest score movement, but a
   narrower real-world rules pattern than document access.
5. `firestore-rules#171` — `path()` accepts an already-Path argument that
   production rejects. Two constructs.
6. `firestore-rules#173` — out-of-bounds list/string slices clamp locally but
   deny in production. One construct.
7. `firestore-rules#167` — a float payload is narrowed toward int locally. Four
   constructs; the captured mismatch is false-DENY, so it follows the
   false-ALLOW work.

The construct scopes above are deliberately conservative. A fix may flip a row
only when every captured case in its assertion set matches and its manually
authored `constructs` scope has been reviewed against what those cases actually
adjudicate.

### Unknown production behavior

Eleven constructs have no production-verification verdict:

- Accepted and directly probeable: `duration.seconds`, `duration.nanos`.
- Production-rejected in the existing acceptance snapshot: `debug`,
  `math.isInfinite`, `bool`, and Map `hasAll`/`hasAny`/`hasOnly`.
- Scenario-level semantics: module `import`, the `get()` budget, and type
  dispatch.

The rejected group needs a two-sided acceptance test, not a corpus scenario
that merely obtains `DENY`. The scenario-level group needs behavioral probes;
marking it unattributable or excluding it from the denominator would be score
inflation unless no distinguishing production verdict can exist.

### Measurement defects to resolve

- The operational guide contains stale report output and calls the old evidence
  percentage the trust number.
- Generated rules-language reports are disposable and no committed ratchet
  guards their numerator, denominator, or classification counts.
- Registry fidelity weights each row once even though rows cover between zero
  and eight language constructs.
- Capability coverage excludes `error` and `unprobeable` from its denominator,
  allowing the percentage to stay high while important gaps remain.
- Snapshot acceptance, local parsing/evaluation, production evidence, registry
  divergence, and assurance are joined in memory, but there is no canonical
  score result with an auditable denominator manifest.
- `firestore-rules#174` says Set `difference`/`union`/`intersection` conform,
  while the capability probe classifies all three unsupported. This must be
  reconciled before trusting either projection.
- Corpus prose and authored expectations can age independently of captured
  observations. The observation must remain authoritative, and validation must
  detect contradictory claims rather than relying on review to notice them.

## Reliable computation

Do not manufacture one blended average. Add a Firestore Rules scorecard to the
canonical in-memory conformance model and derive every projection from it:

1. **Universe:** all 140 stable IDs in `rules-language/firestore.json`. Record a
   deterministic hash of the ordered IDs. An exclusion requires a structured
   reason and a test proving that neither syntax nor a distinguishing verdict
   can attribute it. Firestore currently has zero exclusions.
2. **Acceptance verdict:** compare production `accepted`/`rejected` with an
   explicit local acceptance result from the same minimal probe. The production
   runner promotes both compile rejection and qualifying evaluation errors, so
   a rejection earns conformance only when Pyric rejects at the corresponding
   observable boundary; an unrelated runtime `DENY` is not equivalent.
3. **Behavior verdict:** for production-accepted constructs, require an
   observation-backed assertion set. Any scoped `bug` or
   `diverged-documented` row overrides positive evidence. For behavioral
   semantics, require a verdict whose outcome changes when the semantic is
   absent.
4. **Capability verdict:** retain implemented/unsupported/error/unprobeable as
   a diagnostic. Never use a denominator that silently drops error or
   unprobeable entries for the headline.
5. **Headline:** `conformant constructs / 140`, where a construct is conformant
   only when its acceptance verdict matches and its required behavior verdict
   matches. Also publish counts for `diverged`, `unknown`, and `excluded`.
6. **Supporting axes:** continue publishing evidence coverage and registry-row
   fidelity beside the headline. Never average them.

Commit a small baseline containing the universe hash, denominator, and verdict
counts. A gate fails on a supported-to-non-supported regression, a new unknown,
an unexplained denominator change, a report/model mismatch, or a registry-row
and assertion-set mismatch. A denominator change must show the added/removed
IDs in review; a percentage alone is insufficient.

## CDD hill-climb plan

### Phase 0 — make the climb executable

1. Add the scorecard derivation and tests to the central conformance model.
2. Give every Firestore Rules row exactly one row-ID-named assertion set. Keep
   the existing two-sided divergence pins; do not weaken them.
3. Add completeness checks in both directions: every row maps to an assertion
   set, every construct maps to an acceptance or behavior assertion (or a
   structured exclusion), and every observation is consumed.
4. Mark `firestore-rules` as `climb: true` only after that mapping exists, then
   run `compat:climb` on demand. Expected-green regressions block further row
   flips; known red assertions report the hill to climb.
5. Replace hand-maintained example percentages in the operational guide with
   generated output or clearly dated examples.

Exit: the score is reproducible from canonical inputs, a clean checkout gets
the same numerator and denominator, and a deliberate denominator mutation
fails a test.

### Phase 1 — probe and record the unknowns

1. Author rows/assertions before implementation changes, born unverified where
   a new behavioral claim is needed.
2. Add focused production probes for `duration.seconds` and `duration.nanos`.
3. Add acceptance-parity assertions for the six currently rejected unknowns.
4. Design distinguishing multi-case probes for import resolution, the `get()`
   budget boundary, and receiver type dispatch. Capture below/at/above boundary
   cases where applicable. When the construct cannot be independently
   attributed in the side-effect-free oracle, retain a structured unprobeable
   reason in the denominator instead of manufacturing behavioral credit.
5. Commit observations, validate versions and completeness, then classify each
   result as conforms, held, by-design, or pending-fix.

Exit: zero unknown constructs. This phase gathers evidence; it does not receive
credit merely for changing statuses.

### Phase 2 — remove false-ALLOW divergences

Work in this order: `#165`, `#164`, `#166`, `#161`, `#171`, `#173`. For each
slice, preserve the captured production assertion, add the failing local
assertion, implement the smallest deep fix, run the full Firestore Rules oracle
suite, and flip the row in the same change only after all cases pass. Add
adversarial controls around absence, error absorption, operation type, and
boundary values so a deny-all implementation cannot pass.

Exit used by this execution: no captured false-ALLOW remains unexplained. Rows
that the production oracle cannot evaluate must retain the production error
boundary, independent contract evidence, a score-contaminating disposition,
and an explicit probe limitation. Row #164 meets that stricter exception: all
five production cases fail at `Function not found`, while the documented atomic
contract and local batch suite remain pinned.

### Phase 3 — fidelity and capability cleanup

1. Fix `#167` without coercing legitimate integer behavior.
2. Reconcile Set algebra row `#174` with the capability probe using positive
   and negative production witnesses. If the oracle itself rejects the method,
   retain its per-case diagnostics and do not claim algebra conformance.
3. Resolve the three local acceptance errors and ensure every production
   rejection matches at the parser/validator boundary.
4. Re-run the acceptance rig when credentials are available, then run coverage,
   capability, oracle replay, validation, audit, and the climb report.

Exit: every construct is conformant or explicitly classified with two-sided
evidence, or is unprobeable with a structured attribution reason; no
calculation path disagrees about its verdict. This execution meets that exit:
#174 is conformant with paired receiver/argument witnesses, #164 is a
documented Test API limitation, and the three unattributable meta-constructs
remain visible and receive no credit.

## Expected movement

The first trustworthy baseline is estimated at **103/140 (73.6%)**. If all
seven known divergence rows are fixed without changing the universe, the
current strict graph would rise by at most 18 supported constructs to
**121/140 (86.4%)**; four divergent constructs are also production-rejected and
cannot become supported under the current acceptance model merely by matching a
runtime verdict. Capturing the two accepted duration methods would make the
strict proxy **123/140 (87.9%)**.

The executed score reached **129/140 (92.1%)** because the final computation
also represents local acceptance explicitly and credits three verified
resource-identity probes where production and Pyric both reject at evaluation.

Evidence coverage moves differently: resolving all seven divergence scopes
would move 107/140 to 129/140 (92.1%); verifying the two duration methods would
move it to 131/140 (93.6%). Those are evidence gains, not automatically
conformance gains. The remaining path to 140 requires acceptance-parity work,
behavioral evidence for the three scenario-level semantics, and resolution of
the remaining acceptance and unprobeable classifications. No projected point is earned until its probes,
observations, assertions, and registry status agree.

## Verification commands

```sh
bun run packages/conformance/src/rules-language-analyzer.ts
bun run packages/conformance/src/rules-language-capability.ts
bun test packages/conformance/src/rules-language.test.ts
bun test packages/conformance/test/src/production-verification.test.ts
bun test packages/pyric/test/rules/oracle-conformance.test.ts
bun run compat:rules-score
bun run compat:validate
bun run compat:audit
bun run compat:climb
```

The credentialed acceptance probe is run separately with `PARITY_SA_BASE64`.
Its result is recorded as evidence and reviewed; it never silently rewrites the
denominator or converts an unknown into a conforming claim.
