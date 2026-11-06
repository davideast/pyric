# Rules Standard Library

Use the Standard Library before proposing a Firestore document model, a
Storage object/metadata model, or Security Rules. The available modules reveal
tested policy building blocks and the data they expect.

## Workflow

1. Choose the service: `firestore` or `storage`.
2. Call `rules_stdlib_list({ service })` when available.
3. Call `rules_stdlib_get({ service, key })` for every candidate module.
4. Confirm exact signatures and service compatibility before shaping fields,
   metadata, paths, or allow conditions.
5. Import the selected functions from the modular source. Never copy their
   bodies into project Rules.
6. Resolve the modular source and test the generated version 2 artifact.

Older Pyric versions may expose only `firestore_rules_stdlib_list`,
`firestore_rules_stdlib_get`, and `firestore_resolve_modules`. Use those
aliases for Firestore. For Storage, use this reference when the installed
catalog cannot filter by service; do not invent unavailable commands.

## Source and artifact contract

| Service | Authored source | Generated deployment artifact | Build command |
|---|---|---|---|
| Firestore | `firestore.modules.rules` | `firestore.rules` | `pyric firestore rules resolve firestore.modules.rules --out firestore.rules` |
| Storage | `storage.modules.rules` | `storage.rules` | `pyric storage rules resolve storage.modules.rules --out storage.rules` |

Keep `firebase.json` pointed at the generated artifacts:

```json
{
  "firestore": { "rules": "firestore.rules" },
  "storage": { "rules": "storage.rules" }
}
```

Prefer explicit package scripts so local work and CI use the same build:

```json
{
  "scripts": {
    "rules:build:firestore": "pyric firestore rules resolve firestore.modules.rules --out firestore.rules",
    "rules:build:storage": "pyric storage rules resolve storage.modules.rules --out storage.rules",
    "rules:build": "npm run rules:build:firestore && npm run rules:build:storage"
  }
}
```

Include only the services the application uses.

The generated files are reviewable deployment inputs, not authoring surfaces.
During an audit, resolve to a temporary path and compare it with the committed
artifact. During `execute`, edit the modular source, regenerate the artifact,
review the semantic diff, then lint and simulate the generated file.

## Service compatibility

| Module | Firestore | Storage | Modeling signal |
|---|---:|---:|---|
| `auth` | yes | yes | authenticated and owner-bound access |
| `membership` | yes | yes | claims, member maps, and roles |
| `validation` | yes | no | required/allowed fields, strings, enums |
| `lifecycle` | yes | no | immutable fields and changed-field allowlists |
| `transitions` | yes | no | explicit state transitions |
| `counters` | yes | no | bounded values and exact deltas |
| `timing` | yes | no | server-timestamp cooldowns |
| `content` | yes | no | bounded user-authored text |
| `spaces`, `joining`, `atomic` | yes | no | membership and cross-document invariants |
| `lobby`, `turns`, `state`, `geometry` | yes | no | game/session invariants |
| `storage/uploads` | no | yes | size and declared MIME metadata |
| `storage/metadata` | no | yes | required metadata and owner values |
| `storage/objects` | no | yes | create/update/delete branches |
| `storage/time` | no | yes | existing-object freshness windows |

The installed catalog is authoritative when it differs from this bundled
summary. A module accepted for one service is not automatically portable to
the other.

## Model from policy requirements

Use library signatures as constraints, not as a schema generator:

- If ownership must be immutable, choose a stable owner field or object path,
  then pair `auth` with Firestore lifecycle checks or Storage metadata/path
  checks.
- If readers query by owner or tenant, put that boundary in the Firestore
  document and in the query shape; Rules are not filters.
- If uploads need size or MIME limits, model those as incoming Storage object
  properties and use `storage/uploads`. MIME metadata does not verify bytes.
- If Storage authorization depends on custom metadata, remember that metadata
  is a flat string map. Use `storage/metadata` and separate incoming ownership
  from existing ownership.
- If create, update, and delete have different invariants, use distinct allow
  branches. `storage/objects` identifies those operations without unsafe
  missing-binding checks.

Do not distort a simple model just to use more modules. Select only helpers
that express real product invariants.
