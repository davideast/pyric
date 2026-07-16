---
title: "API reference: pyric/sandbox/firestore"
navLabel: "pyric/sandbox/firestore"
group: "API reference"
section: "pyric"
order: 9032
description: "Published declarations for pyric/sandbox/firestore."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/sandbox/firestore"
apiSubpath: "sandbox/firestore"
apiSymbolCount: 6
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="firestoreinspectoptions"></a>

### FirestoreInspectOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="recenteventlimit"></a> `recentEventLimit?` | `number` | Maximum number of recent requests and denials to return. Defaults to 10. |

***

<a id="firestoreinspectreport"></a>

### FirestoreInspectReport

Stable JSON-serializable Firestore diagnostic used by Studio and tools.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="documents"></a> `documents` | \{ `byCollection`: `Record`\<`string`, `number`\>; `totalCount`: `number`; \} |
| `documents.byCollection` | `Record`\<`string`, `number`\> |
| `documents.totalCount` | `number` |
| <a id="events"></a> `events` | \{ `recentDenials`: \{ `auth`: `unknown`; `debugMessage?`: `string`; `method`: `string`; `path`: `string`; \}[]; `recentRequests`: \{ `auth`: `unknown`; `method`: `string`; `path`: `string`; `result`: `string`; \}[]; `totalCount`: `number`; \} |
| `events.recentDenials` | \{ `auth`: `unknown`; `debugMessage?`: `string`; `method`: `string`; `path`: `string`; \}[] |
| `events.recentRequests` | \{ `auth`: `unknown`; `method`: `string`; `path`: `string`; `result`: `string`; \}[] |
| `events.totalCount` | `number` |
| <a id="rules"></a> `rules` | \{ `isEmpty`: `boolean`; `lint`: \{ `errors`: `number`; `findings`: \{ `message`: `string`; `rule`: `string`; `severity`: `string`; \}[]; `info`: `number`; `warnings`: `number`; \}; `sizeBytes`: `number`; `source`: `string`; \} |
| `rules.isEmpty` | `boolean` |
| `rules.lint` | \{ `errors`: `number`; `findings`: \{ `message`: `string`; `rule`: `string`; `severity`: `string`; \}[]; `info`: `number`; `warnings`: `number`; \} |
| `rules.lint.errors` | `number` |
| `rules.lint.findings` | \{ `message`: `string`; `rule`: `string`; `severity`: `string`; \}[] |
| `rules.lint.info` | `number` |
| `rules.lint.warnings` | `number` |
| `rules.sizeBytes` | `number` |
| `rules.source` | `string` |

## Functions

<a id="inspect"></a>

### inspect()

```ts
function inspect(sandbox: LocalSandbox, options?: FirestoreInspectOptions): FirestoreInspectReport;
```

Inspect Firestore rules, documents, and recent requests in one sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `options?` | [`FirestoreInspectOptions`](#firestoreinspectoptions) |

#### Returns

[`FirestoreInspectReport`](#firestoreinspectreport)

***

<a id="seeddocuments"></a>

### seedDocuments()

```ts
function seedDocuments(sandbox: LocalSandbox, documents: Record<string, DocumentData>): LintResult;
```

Replace Firestore documents in bulk, preserving rules and bypassing evaluation.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `documents` | `Record`\<`string`, `DocumentData`\> |

#### Returns

`LintResult`

***

<a id="setrules"></a>

### setRules()

```ts
function setRules(sandbox: LocalSandbox, source: string): LintResult;
```

Load Firestore Rules into one sandbox and notify its live listeners.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `source` | `string` |

#### Returns

`LintResult`

***

<a id="snapshotdocuments"></a>

### snapshotDocuments()

```ts
function snapshotDocuments(sandbox: LocalSandbox): Record<string, DocumentData>;
```

Snapshot only Firestore documents without traversing other sandbox services.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |

#### Returns

`Record`\<`string`, `DocumentData`\>
