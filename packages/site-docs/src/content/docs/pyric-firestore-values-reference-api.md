---
title: "API reference: pyric/firestore-values"
navLabel: "pyric/firestore-values"
group: "API reference"
section: "pyric"
order: 24025
description: "Published declarations for pyric/firestore-values."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/firestore-values"
apiSubpath: "firestore-values"
apiSymbolCount: 1
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Functions

<a id="rehydratedocvalue"></a>

### rehydrateDocValue()

```ts
function rehydrateDocValue(value: unknown): unknown;
```

Walk a parsed JSON tree and re-wrap any marker shape back into its real
wrapper-class instance. Visits arrays and plain objects recursively. Plain
values (and plain objects without a recognized discriminator) pass through.

This is the canonical rehydrate used by BOTH the sandbox persistence
serializer and the SharedWorker wire protocol, so the IDB format and the
MessagePort wire format are guaranteed identical.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`unknown`
