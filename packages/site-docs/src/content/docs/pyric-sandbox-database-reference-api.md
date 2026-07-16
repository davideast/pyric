---
title: "API reference: pyric/sandbox/database"
navLabel: "pyric/sandbox/database"
group: "API reference"
section: "pyric"
order: 9031
description: "Published declarations for pyric/sandbox/database."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/sandbox/database"
apiSubpath: "sandbox/database"
apiSymbolCount: 5
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Type Aliases

<a id="rtdbrulesjson"></a>

### RtdbRulesJson

```ts
type RtdbRulesJson = {
  rules: Record<string, unknown>;
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="rules"></a> `rules` | `Record`\<`string`, `unknown`\> |

## Functions

<a id="getactiverules"></a>

### getActiveRules()

```ts
function getActiveRules(sandbox: LocalSandbox): RtdbRulesJson;
```

Read the currently active rules as detached JSON.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |

#### Returns

[`RtdbRulesJson`](#rtdbrulesjson)

***

<a id="setdata"></a>

### setData()

```ts
function setData(sandbox: LocalSandbox, data: Record<string, unknown>): void;
```

Replace RTDB data in bulk without applying security rules.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `data` | `Record`\<`string`, `unknown`\> |

#### Returns

`void`

***

<a id="setrules"></a>

### setRules()

```ts
function setRules(sandbox: LocalSandbox, rules: RtdbRulesJson): void;
```

Replace the active RTDB rules. Pass `null` to restore default allow.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `rules` | [`RtdbRulesJson`](#rtdbrulesjson) |

#### Returns

`void`

***

<a id="snapshotstate"></a>

### snapshotState()

```ts
function snapshotState(sandbox: LocalSandbox): JsonValue;
```

Snapshot the complete RTDB tree without applying security rules.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |

#### Returns

`JsonValue`
