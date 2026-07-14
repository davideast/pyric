<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric-admin/firestore

## Functions

### getFirestore()

> **getFirestore**(`target?`): `SandboxFirestore`

Return the admin Firestore handle.

  - `getFirestore(ctx)` — the original context form (rules-applied for the
    ctx's captured identity). Unchanged; idempotent per `SandboxContext`.
  - `getFirestore(app)` — resolves a PyricAdminApp's sandbox.
  - `getFirestore()` — resolves the default app; throws `app/no-app` when
    nothing is initialized.

#### Parameters

##### target?

`any`

#### Returns

`SandboxFirestore`
