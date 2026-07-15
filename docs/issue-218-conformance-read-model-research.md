# Issue #218 research: one conformance model, fewer committed projections

**Investigated:** 2026-07-14 at `10cb37e0` (`origin/main`)

**Primary sources:** GitHub issues and pull requests, repository source, and repository Git history.

## Conclusion

Issue [#218](https://github.com/davideast/pyric/issues/218) is worth doing, but its original plan was too narrow for the review problem and stale in several important ways. It has now been rewritten as a **Trust** priority: one derivation should answer what exists, how faithfully it behaves, what evidence supports the claim, and whether assurance may rely on it. The developer-facing `canIUse` query is the public trust surface over that derivation.

The durable architecture should be:

```text
committed canonical inputs
  registry rows + rules-language inventory + surface contracts + observations + ratchet baselines
                               |
                               v
                    deriveConformanceModel()
                               |
             +-----------------+-----------------+
             |                 |                 |
             v                 v                 v
       assurance lookup   can-I-use query   docs/reports/scores
       (runtime bundle)   (runtime bundle)  (build artifacts)
```

Commit the evidence and ratchet state. Build the projections. Do not keep byte-identical or mechanically ported copies in Git merely so a drift check can compare one generated file with another.

This passes the repository's Trust test in [`PRIORITIES.md`](../PRIORITIES.md): it makes the contract, gaps, evidence, and path to production queryable without allowing multiple derived artifacts to disagree. It also solves the stated maintainer problem: generated projections currently occupy **17,156 committed lines**, and since June 1 their source-side files produced **19,052 changed lines** while their site ports produced another **11,642 changed lines**.

### Pre-implementation decision: replace the hard-coded denylist

The investigation initially treated `src/surface-denylist.ts` as a canonical input because that is the live architecture at `10cb37e0`. The pre-implementation plan now deliberately removes it. Every authored surface descriptor becomes a schema-validated `surfaces/<surface-key>.json` contract; mirror contracts carry exact structured availability dispositions, while the conformance model reconciles those dispositions with live upstream and mirror exports. This preserves explicit review of all 98 current classifications without keeping policy data, prose, types, and lookup implementation in one executable source module. Historical sections below still describe the file as it existed when investigated.

## What the epic actually requires

The revised epic defines two outcomes and five ordered sub-issues:

| Order | Issue | Actual requirement | Current state |
|---|---|---|---|
| prerequisite | [#213](https://github.com/davideast/pyric/pull/213) | Probes name graph nodes directly with `requires`; remove the older capability-id requirement path. | Merged 2026-07-12. The runtime still flattens node verdicts out of the generated capability catalog. |
| 1 | [#214](https://github.com/davideast/pyric/issues/214) | Delete 16 authored capability records and the catalog copies; emit a small node-verdict lookup for assurance. | Open. No implementation PR cross-references it. Standalone and intended to land first. |
| 2 | [#215](https://github.com/davideast/pyric/issues/215) | Derive the central model, migrate surface descriptors/dispositions to machine-readable contracts, and build a one-to-many feature index. | Open; depends on #214. Rewritten after this investigation to address the live registry and hard-coded denylist. |
| 3a | [#303](https://github.com/davideast/pyric/issues/303) | Stop committing disposable COMPAT/SCORES, site ports, reports, and runtime projections. | Open; depends on #215 and may proceed alongside #216. |
| 3b | [#216](https://github.com/davideast/pyric/issues/216) | Implement a pure `canIUse(feature)` translation that preserves availability, fidelity, and assurance separately. | Open; depends on #215 and may proceed alongside #303. |
| 4 | [#217](https://github.com/davideast/pyric/issues/217) | Expose the query through MCP and at the `pyric verify` decision point. | Open; depends on #216 and is related to Trust item [#133](https://github.com/davideast/pyric/issues/133), which remains open. |

At investigation time, #214–#217 were body checkboxes rather than GitHub `subIssues`. The planning pass registered #214, #215, #216, #217, and new projection-cleanup issue #303 as native sub-issues and reclassified them under Trust. There are no implementation PRs attached to them. The epic is also cross-referenced by merged [PR #220](https://github.com/davideast/pyric/pull/220) and the later Trust-repair epic [#261](https://github.com/davideast/pyric/issues/261). #261 explicitly keeps #218 independent and says its stale examples must be refreshed before implementation.

The dependency order is now: land the assurance reduction (#214), complete the central model/surface contracts/feature index (#215), then run projection cleanup (#303) and the pure query (#216) independently before adding the public consumer (#217).

## Current conformance truth and its projections

The repository already describes the registry as the source for generated compatibility docs and observations as the production evidence behind claims ([conformance map](../packages/conformance/README.md)). Rules-language snapshots enumerate constructs, and a small shared production graph gives divergences precedence over positive evidence ([`production-verification.ts`](../packages/conformance/src/production-verification.ts#L95-L160)).

The assurance path is less direct than the epic's “graph” shorthand suggests. [`loadConformanceGraph()`](../packages/conformance/src/assurance-capabilities.ts#L235-L273) reads:

- construct statuses from the three rules-language snapshots;
- simulator classifications from committed generated `capability-report.json`;
- production verification from committed generated `coverage-report.json`;
- compatibility rows from the registries; and
- construct-scoped proving/diverging rows from those registries.

It then combines those facts with 16 authored capability grouping records and writes three copies: `capabilities.json`, a conformance-side TypeScript module, and a CLI runtime TypeScript module ([generator outputs](../packages/conformance/src/assurance-capabilities.ts#L177-L193), [write path](../packages/conformance/src/assurance-capabilities.ts#L740-L778)). The live runtime is now under `packages/cli`, not the `pyric-tools` paths named throughout #218–#217.

The generated footprint relevant to this work is:

| Projection family | Files | Current lines |
|---|---:|---:|
| package-side COMPAT matrices + SCORES | 10 | 2,171 |
| committed site-doc ports of those same pages | 10 | 4,712 |
| assurance catalog/copies | 3 | 2,206 |
| rules-language generated reports | 3 | 7,107 |
| committed ratchet baselines | 3 | 960 |
| **Total** | **29** | **17,156** |

The site duplication is especially avoidable. The port script says it owns the output directory, deletes and rewrites it, and ports all package docs ([`port-content.ts`](../packages/site-docs/scripts/port-content.ts#L1-L38)); it explicitly lists the ten conformance pages ([same file](../packages/site-docs/scripts/port-content.ts#L484-L520)). The site `build` command already runs that port before Astro ([`package.json`](../packages/site-docs/package.json#L6-L13)). Those ten site copies have no independent authorship role.

The package-side matrices are also declared generated and are byte-compared to registry rendering ([`generate-docs.ts`](../packages/conformance/src/generate-docs.ts#L10-L35), [drift/write logic](../packages/conformance/src/generate-docs.ts#L352-L385)). They are not shipped in the `pyric` npm package, whose `files` allowlist is `dist`, `README.md`, and `LICENSE` ([`packages/pyric/package.json`](../packages/pyric/package.json)). Their consumer is the docs port/build, so they can be rendered as part of that build instead of reviewed as source changes.

### Reproducible churn measurement

At `10cb37e0`, `wc -l` over the 29 paths above produces the table totals. Churn was calculated from primary Git history with:

```bash
git log --since=2026-06-01 --numstat --format='' -- <projection paths> \
  | awk 'NF == 3 { additions += $1; deletions += $2 } END { print additions + deletions }'
```

The 19 source-side projection/baseline paths produce 15,748 additions + 3,304 deletions = **19,052 changed lines**. The ten `packages/site-docs/src/content/docs/pyric-*-compat.md`/scores ports produce 8,177 additions + 3,465 deletions = **11,642 changed lines**. This is generated churn, not an anecdotal concern.

## Where the current design no longer fits reality

### 1. A feature does not map to one registry-row id

#215 proposes `FEATURE_INDEX: Record<'surface/symbol', id>`. The registry is behavior-granular: one developer feature commonly has several rows. For example, `getDownloadURL` has distinct rows for URL shape/lifetime and missing-object behavior (`storage#51` and `storage#52`), plus related production-answer rows. Returning one id would silently hide claims or require an arbitrary “primary” row.

The index must therefore be one-to-many:

```ts
type FeatureKey = `${DeveloperSurface}/${string}`;
type FeatureIndex = Readonly<Record<FeatureKey, readonly ConformanceNodeId[]>>;
```

The public result should aggregate every matching claim while retaining claim ids/evidence in details.

### 2. The registry has no canonical symbol field

`CompatibilityRow` has `api`, `aliases`, `behavior`, and evidence fields, but no symbol ([registry type](../packages/conformance/registry/types.ts#L52-L73)). `api` is display copy and frequently contains signatures, paired APIs, alternatives, or Pyric-specific helpers; it is not a safe machine join key. Rules constructs likewise have a stable id and kind but no developer-facing symbol field ([rules-language type](../packages/conformance/rules-language/types.ts#L82-L111)).

Therefore “zero new authored data” and a reliable developer-name index cannot both be acceptance criteria. The smallest honest addition is optional canonical feature metadata **on the existing source records**, not a new catalog:

```ts
interface CompatibilityRow {
  featureKeys?: readonly string[]; // e.g. ['getDownloadURL']
}

interface LanguageConstruct {
  featureKeys?: readonly string[]; // only where id parsing is insufficient
}
```

Most construct names can receive a deterministic default from their stable ids; validation should require explicit metadata for ambiguous registry display strings and ensure every public/deferred census symbol resolves. This preserves one source rather than inventing a parallel feature catalog.

### 3. `knownIssue` cannot be a pure, zero-I/O translation over current facts

#216 names open GitHub issues #205 and #201 as `knownIssue` sources, but both are closed: [#201](https://github.com/davideast/pyric/issues/201) was fixed by [PR #220](https://github.com/davideast/pyric/pull/220), and [#205](https://github.com/davideast/pyric/issues/205) was fixed by [PR #230](https://github.com/davideast/pyric/pull/230). The registry has no machine-readable issue field, and a pure runtime function cannot know whether a GitHub issue is open without either generated network state or authored status.

Do not make live GitHub state part of the runtime contract. Derive `knownGap` from canonical conformance state (`bug`, `diverged-documented`, `unsupported`, `unverified`) and return evidence/row ids. If an issue URL is useful, add an optional stable `trackingIssue` to the source row; never derive semantics from whether that remote issue happens to be open.

### 4. The example data is stale, even where the resulting answer remains useful

- `getDownloadURL` landed in [PR #231](https://github.com/davideast/pyric/pull/231). It should still answer “partial” because the registry now records its page-local `blob:` URL identity/lifetime divergence, not because it is denylisted.
- `getAfter()` remains a documented rules-engine divergence (`firestore-rules#164`) and is a valid partial/unsafe-to-assure example.
- `onDisconnect` remains deferred in [`surface-denylist.ts`](../packages/conformance/src/surface-denylist.ts), so it is a valid unavailable/deferred example.
- #201 and #205 must not be returned as open known issues.

### 5. One `support` value would undo the current three-axis trust model

After #218 was written, merged [PR #269](https://github.com/davideast/pyric/pull/269) established three distinct published axes: total surface availability, intended surface availability, and behavior fidelity. The generator explicitly says not to fold coverage into fidelity ([`generate-docs.ts`](../packages/conformance/src/generate-docs.ts#L30-L35)). #218 currently mixes denylist availability, registry fidelity, and assurance eligibility into one `supported | partial | unsupported | unverified` field.

The public facade can stay small, but it must preserve the distinction:

```ts
interface FeatureSupport {
  feature: string;
  surface: DeveloperSurface;
  availability: 'available' | 'deferred' | 'out-of-scope';
  fidelity: 'conforms' | 'diverged' | 'bug' | 'unverified' | 'not-applicable';
  assurance: 'eligible' | 'qualified' | 'ineligible' | 'not-applicable';
  summary: string;
  claims: readonly {
    id: string;
    behavior: string;
    status: string;
    evidence: readonly string[];
  }[];
}
```

`canIUse('getDownloadURL')` then says “available; fidelity diverges in URL identity/lifetime,” while `canIUse('onDisconnect')` says “deferred; fidelity not applicable.” That is more trustworthy than calling both “partial” or “unsupported.” A compact presentation may derive a headline, but the underlying API must not destroy the axes.

### 6. The proposed surface union is already incomplete

The epic lists only auth, Firestore, RTDB, Storage, and Messaging. The current registry surface type also includes App, AI, Messaging SW/Admin, Functions·RTDB, and the three rules-engine surfaces ([`registry/types.ts`](../packages/conformance/registry/types.ts)). The public API needs a deliberate normalized `DeveloperSurface` mapping; it should not leak internal registry partitioning, but silently omitting current published surfaces is not a “grows later” neutral choice.

## Recommended rewrite and delivery sequence

### Phase 0: reclassify and refresh the epic

1. Label #218 `priority:trust`, add it to the Trust “Now” list in `PRIORITIES.md`, and state the Trust test in the issue.
2. Replace all `pyric-tools` paths with `packages/cli` paths.
3. Replace #201/#205 open-issue examples and update `getDownloadURL` from denylisted to implemented-with-divergence.
4. Make “reduce committed generated projections and PR churn” an explicit outcome, not merely a side effect of deleting the assurance catalog.

### Architecture target: centralize derivation, not data copies

Create one side-effect-free `deriveConformanceModel()` in the private conformance package. It should consume canonical inputs directly:

- typed registries;
- rules-language inventories;
- simulator analysis computed in memory (today serialized as `capability-report.json`);
- production-verification analysis computed in memory (today serialized as `coverage-report.json`);
- schema-validated surface contracts reconciled with live upstream/mirror exports; and
- frozen observations/row links as evidence.

All scoring, assurance, reports, docs, and runtime emitters should call this model. Generated JSON reports remain optional human/CI exports of the model, never inputs read back into another derivation.

### Delivery 1: land #214's immediate reduction

Delete the 16 capability grouping records, `capabilities.json`, conformance-side `generated.ts`, and CLI `generated-capabilities.ts`. Before CLI TypeScript compilation, deterministically emit verdicts for every addressable graph node into an ignored browser-safe module and have `resolveRequiredNode` call `verdictOf(id)`. This avoids scanning built probes or authoring a second required-node catalog; measure the raw/gzip cost before considering a narrower later projection. Preserve the package seam: the published CLI cannot import the private conformance package at runtime, so generation belongs in the CLI build/prebuild.

This is the low-risk independent slice already identified by #214. Its acceptance should assert behavior (abstention reason and qualification tests), not byte equality among committed copies.

### Delivery 2: complete the model, surface contracts, and feature index

Finish `deriveConformanceModel()` around the architecture target above. Convert every authored surface descriptor and the census-only service-worker record to versioned, schema-validated `surfaces/<surface-key>.json` contracts. Mirror contracts carry exact structured availability dispositions; native, integration, and census-only records use the same contract union without irrelevant fields. Reconcile those contracts with live upstream/mirror exports, preserve all 98 classifications and coverage numbers, delete `surface-denylist.ts`, and add the one-to-many developer feature index.

### Delivery 3: stop committing disposable projections

1. Generate COMPAT/SCORES immediately before the docs port, or let the port consume the renderer in memory.
2. Stop tracking the ten site-port copies; they are already rebuilt by `site-docs build`.
3. Stop tracking the ten package-side COMPAT/SCORES outputs once the site build produces them in a temporary/generated directory. Keep the published HTML and `.md` twins as deployment artifacts.
4. Stop tracking `coverage-report.json`, `capability-report.json`, and `acceptance-report.json` as downstream projections. Produce them as CI artifacts or explicit local reports. Preserve any irreplaceable production observation as a canonical observation/snapshot fact before removal.
5. Keep committed baselines where they are genuine ratchet state. A baseline is not interchangeable with a report: it records the last accepted threshold and therefore needs review when it moves.

For a transitional release, it is reasonable to keep only the runtime-generated modules committed if a clean-checkout build cannot yet generate them. That is still a large improvement. The end state should generate them in prebuild and verify their behavioral contract in tests.

### Delivery 4: build the corrected feature facade

1. Add validated feature keys to canonical rows/constructs only where deterministic derivation is ambiguous.
2. Build a one-to-many feature index.
3. Aggregate all claims without collapsing availability, fidelity, and assurance eligibility.
4. Derive summaries from structured state; use source-row caveat/issue metadata only where a human sentence is genuinely necessary.

### Delivery 5: expose the public consumer

Expose the pure query to MCP and `pyric verify` discovery as #217/#133 require.

## Proposed acceptance criteria for the rewritten epic

- One `deriveConformanceModel()` supplies assurance, scoring, reports, docs, and `canIUse`; no generated report is read as an input by another generator.
- A registry or rules change is authored once. Ordinary PRs do not contain package COMPAT output plus a second committed site copy.
- Canonical evidence (observations, row links, construct inventory, and schema-validated surface dispositions) remains committed and reviewable.
- `packages/conformance/src/surface-denylist.ts` is gone; every upstream symbol has exactly one derived availability classification, with stale/redundant/duplicate/unmapped states fatal.
- Ratchet baselines remain explicit and receive adversarial review whenever a published number moves.
- A clean checkout can build the CLI and docs without pre-existing generated files.
- The docs build publishes the same ten conformance pages and Markdown twins from the model.
- Assurance abstentions still name the required node, derived state, and plain reason.
- `canIUse` resolves one feature to all relevant claims, handles ambiguous names deterministically, and returns availability, fidelity, and assurance separately.
- `getAfter`, `getDownloadURL`, and `onDisconnect` exercise respectively diverged rules behavior, available-but-diverged SDK behavior, and deferred availability.
- No runtime result depends on live GitHub issue state.

## Risks and guardrails

- **Do not replace many small committed projections with one enormous committed global projection.** That reduces file count but makes every change touch the same hotspot. Centralize the in-memory model; generate consumer-specific bundles at build time.
- **Do not discard evidence while deleting reports.** Frozen production observations and the construct inventory are inputs; generated coverage/capability summaries are projections. Classify each file before untracking it.
- **Do not weaken the package seam.** Browser assurance should receive only the small lookup it needs; the Node query may use the richer feature bundle.
- **Do not infer feature identity by parsing display prose indefinitely.** Use validation and narrowly-scoped canonical feature keys.
- **Do not collapse the three trust questions back into one percentage or enum.** Availability, fidelity, and assurance eligibility answer different user questions.
