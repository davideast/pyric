---
title: "API reference: @pyric/cli/conformance/browser"
navLabel: "@pyric/cli/conformance/browser"
group: "API reference"
section: "@pyric/cli"
order: 24016
description: "Published declarations for @pyric/cli/conformance/browser."
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/conformance/browser"
apiSubpath: "conformance/browser"
apiSymbolCount: 11
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="browserfeaturesupport"></a>

### BrowserFeatureSupport

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="assurance"></a> `assurance` | [`Assurance`](#assurance-1) |
| <a id="availability"></a> `availability` | [`Availability`](#availability-1) |
| <a id="caveats"></a> `caveats` | readonly `string`[] |
| <a id="evidenceslug"></a> `evidenceSlug` | `string` |
| <a id="feature"></a> `feature` | `string` |
| <a id="fidelity"></a> `fidelity` | [`Fidelity`](#fidelity-1) |
| <a id="importpaths"></a> `importPaths` | readonly `string`[] |
| <a id="summary"></a> `summary` | `string` |
| <a id="surface"></a> `surface` | [`DeveloperSurface`](#developersurface) |

***

<a id="caniuseoptions"></a>

### CanIUseOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="importpath"></a> `importPath?` | `string` | Restrict the answer to features exposed through this published import. |

***

<a id="caniuseresult"></a>

### CanIUseResult

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

<a id="caniusetooloptions"></a>

### CanIUseToolOptions

#### Type Parameters

| Type Parameter |
| :------ |
| `R` *extends* `CanIUseResultLike` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="description"></a> `description` | `string` |
| <a id="featuredescription"></a> `featureDescription` | `string` |
| <a id="importpathdescription"></a> `importPathDescription` | `string` |
| <a id="query-1"></a> `query` | (`feature`: `string`, `options`: \{ `importPath?`: `string`; \}) => `R` |

## Type Aliases

<a id="assurance-1"></a>

### Assurance

```ts
type Assurance = "eligible" | "qualified" | "ineligible" | "not-applicable";
```

***

<a id="availability-1"></a>

### Availability

```ts
type Availability = "available" | "unavailable" | "deferred" | "out-of-scope";
```

***

<a id="caniusematch"></a>

### CanIUseMatch

```ts
type CanIUseMatch = "exact" | "ambiguous" | "suggestions" | "none";
```

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

## Functions

<a id="caniuse"></a>

### canIUse()

```ts
function canIUse(query: string, options?: CanIUseOptions): CanIUseResult<BrowserFeatureSupport>;
```

Query the compact browser projection. Full claims and evidence remain on
the Node-only `@pyric/cli/conformance` entry point.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | `string` |
| `options?` | [`CanIUseOptions`](#caniuseoptions) |

#### Returns

[`CanIUseResult`](#caniuseresult)\<[`BrowserFeatureSupport`](#browserfeaturesupport)\>

***

<a id="createcaniusetool"></a>

### createCanIUseTool()

```ts
function createCanIUseTool<R>(options: CanIUseToolOptions<R>): ToolHandler;
```

The one authored pyric_can_i_use handler shape. Node and browser agents
differ only in the query they pass in, so match semantics, argument
validation, and summaries cannot drift between surfaces.

#### Type Parameters

| Type Parameter |
| :------ |
| `R` *extends* `CanIUseResultLike` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`CanIUseToolOptions`](#caniusetooloptions)\<`R`\> |

#### Returns

`ToolHandler`
