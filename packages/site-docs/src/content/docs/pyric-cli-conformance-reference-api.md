---
title: "API reference: @pyric/cli/conformance"
navLabel: "@pyric/cli/conformance"
group: "API reference"
section: "@pyric/cli"
order: 24017
description: "Published declarations for @pyric/cli/conformance."
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/conformance"
apiSubpath: "conformance"
apiSymbolCount: 13
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="caniuseoptions"></a>

### CanIUseOptions

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="importpath"></a> `importPath?` | `string` | Restrict the answer to features exposed through this published import. |

***

<a id="caniuseresult"></a>

### CanIUseResult

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* `QueryableFeatureSupport` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="match"></a> `match` | [`CanIUseMatch`](#caniusematch) |
| <a id="query"></a> `query` | `string` |
| <a id="supports"></a> `supports` | readonly `T`[] |

***

<a id="featureclaim"></a>

### FeatureClaim

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="assurance"></a> `assurance` | [`Assurance`](#assurance-2) |
| <a id="behavior"></a> `behavior` | `string` |
| <a id="evidence"></a> `evidence` | readonly `string`[] |
| <a id="id"></a> `id` | `string` |
| <a id="kind"></a> `kind` | [`FeatureClaimKind`](#featureclaimkind-1) |
| <a id="status"></a> `status` | `string` |
| <a id="surface"></a> `surface` | `string` |

***

<a id="featuresupport"></a>

### FeatureSupport

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="assurance-1"></a> `assurance` | [`Assurance`](#assurance-2) |
| <a id="availability"></a> `availability` | [`Availability`](#availability-1) |
| <a id="caveats"></a> `caveats` | readonly `string`[] |
| <a id="claims"></a> `claims` | readonly [`FeatureClaim`](#featureclaim)[] |
| <a id="evidenceslug"></a> `evidenceSlug` | `string` |
| <a id="feature"></a> `feature` | `string` |
| <a id="fidelity"></a> `fidelity` | [`Fidelity`](#fidelity-1) |
| <a id="importpaths"></a> `importPaths` | readonly `string`[] |
| <a id="summary"></a> `summary` | `string` |
| <a id="surface-1"></a> `surface` | [`DeveloperSurface`](#developersurface) |

***

<a id="importevidence"></a>

### ImportEvidence

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="evidenceslug-1"></a> `evidenceSlug` | `string` |
| <a id="importpath-1"></a> `importPath` | `string` |
| <a id="surface-2"></a> `surface` | [`DeveloperSurface`](#developersurface) |

## Type Aliases

<a id="assurance-2"></a>

### Assurance

```ts
type Assurance = "eligible" | "qualified" | "ineligible" | "not-applicable";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

***

<a id="availability-1"></a>

### Availability

```ts
type Availability = "available" | "unavailable" | "deferred" | "out-of-scope";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

***

<a id="caniusematch"></a>

### CanIUseMatch

```ts
type CanIUseMatch = "exact" | "ambiguous" | "suggestions" | "none";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

***

<a id="developersurface"></a>

### DeveloperSurface

```ts
type DeveloperSurface =
  | "ai"
  | "app"
  | "auth"
  | "firestore"
  | "firestore-rules"
  | "functions-rtdb"
  | "messaging"
  | "messaging-admin"
  | "rtdb"
  | "rtdb-rules"
  | "storage"
  | "storage-rules";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

***

<a id="featureclaimkind-1"></a>

### FeatureClaimKind

```ts
type FeatureClaimKind = "runtime-export" | "type-export" | "registry-row" | "rules-construct";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

***

<a id="fidelity-1"></a>

### Fidelity

```ts
type Fidelity =
  | "conforms"
  | "diverged"
  | "bug"
  | "unsupported"
  | "unverified"
  | "not-applicable";
```

Query Pyric's build-time conformance model by developer-facing feature name.
Results keep availability, behavior fidelity, and assurance eligibility as
separate trust axes.

## Functions

<a id="caniuse"></a>

### canIUse()

```ts
function canIUse(query: string, options?: CanIUseOptions): CanIUseResult<FeatureSupport>;
```

Query the generated, build-time conformance support projection.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | `string` |
| `options?` | [`CanIUseOptions`](#caniuseoptions) |

#### Returns

[`CanIUseResult`](#caniuseresult)\<[`FeatureSupport`](#featuresupport)\>

***

<a id="caniuseimport"></a>

### canIUseImport()

```ts
function canIUseImport(importPath: string): ImportEvidence;
```

Find the generated compatibility-page evidence for a published import.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `importPath` | `string` |

#### Returns

[`ImportEvidence`](#importevidence)
