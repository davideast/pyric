# Storage Rules Audit

Audit Storage paths, operations, incoming object properties, existing object
properties, and identity together.

## Steps

1. Read `storage.modules.rules`, `storage.rules`, the Storage block in
   `firebase.json`, upload/download/delete call sites, and object path
   construction.
2. Read [rules-standard-library.md](rules-standard-library.md), then inspect
   the installed Storage-compatible catalog before judging the object or
   metadata model.
3. Confirm the source/artifact contract:
   `storage.modules.rules` is authored, `storage.rules` is generated, and
   `firebase.json` points at `storage.rules`.
4. Resolve the modular source to a temporary file and compare it with
   `storage.rules`. Report drift, unresolved imports, and direct edits to the
   artifact.
5. Map each path to `get`, `list`, `create`, `update`, and `delete`. Record
   signed-out, owner, non-owner, tenant, and claim-holder outcomes.
6. Check incoming upload size, declared content type, custom metadata, owner
   immutability, and path ownership. Treat MIME metadata as a claim about the
   object, not proof of its bytes.
7. Parse/lint the generated artifact and simulate one intended ALLOW plus an
   adjacent one-dimension DENY mutation for every important boundary.

## High-signal failures

- Any public write to user or tenant paths.
- One broad write condition shared by create, update, and delete despite
  different invariants.
- Ownership accepted only from incoming metadata on update.
- User-controlled owner metadata that can be changed after create.
- Content-type checks presented as file-content validation.
- `firebase.json` pointed at `storage.modules.rules`.
- `storage.rules` out of sync with `storage.modules.rules`.
- Missing size limits on abuse-sensitive uploads.

When remediation is explicitly requested through `execute`, edit
`storage.modules.rules`, regenerate `storage.rules`, review the generated
semantic diff, and rerun the same simulations.
