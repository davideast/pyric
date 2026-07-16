---
title: "API reference: pyric-admin/firestore"
navLabel: "pyric-admin/firestore"
group: "API reference"
section: "pyric-admin"
order: 9006
description: "Published declarations for pyric-admin/firestore."
kind: "api"
apiPackage: "pyric-admin"
apiImportPath: "pyric-admin/firestore"
apiSubpath: "firestore"
apiSymbolCount: 1
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Functions

<a id="getfirestore"></a>

### getFirestore()

```ts
function getFirestore(target?: any): SandboxFirestore;
```

Return the admin Firestore handle.

  - `getFirestore(ctx)` — the original context form (rules-applied for the
    ctx's captured identity). Unchanged; idempotent per `SandboxContext`.
  - `getFirestore(app)` — resolves a PyricAdminApp's sandbox.
  - `getFirestore()` — resolves the default app; throws `app/no-app` when
    nothing is initialized.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `target?` | `any` |

#### Returns

`SandboxFirestore`
