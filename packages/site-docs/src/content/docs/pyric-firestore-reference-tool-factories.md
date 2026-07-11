---
title: "Tool factories"
group: "pyric / firestore"
section: "Reference"
order: 12014
---
# Tool factories

`createFirestoreDataTools(deps)` wraps the modular Firestore data plane as `@inbrowser/agent` tool handlers.
```ts
import { createFirestoreDataTools } from 'pyric/firestore';
import { createToolRegistry } from '@inbrowser/agent';

const tools = createFirestoreDataTools({
  resolveDb: async (actor) => /* return a Firestore handle for this identity */,
});

const registry = createToolRegistry();
for (const h of tools) registry.register(h);
```
## `FirestoreDataToolDeps`
```ts
interface FirestoreDataToolDeps {
  resolveDb: (as?: As) => Promise<Firestore> | Firestore;
}
```
The resolver fires per-dispatch with the op's `as` value. Hosts decide what backend to return:

- **`'admin'` (or omitted)**: an admin-mode handle that BYPASSES rules. The default, for sandbox seeding.
- **`{ uid, claims? }`**: a rules-enforcing handle acting as that user, e.g. `getFirestore(sandbox.withAuth({ uid, token: claims }))` or a `FirebaseServerApp`-backed Firestore.

A sandbox resolver may default to admin. A resolver wired to a promoted/real backend MUST reject `'admin'` and require an explicit identity.

## `As`
```ts
type As = 'admin' | UserAuth;

interface UserAuth {
  uid: string;
  claims?: Record<string, unknown>;
}
```
The value passed to `resolveDb` from a tool call's `as` field. The explicit `'admin'` literal makes bypass **named** (you opt into it by writing `as: 'admin'` rather than it being the silent consequence of omitting an auth field), and `{ uid }` names the user to act as. Omitting `as` is treated as `'admin'`.

## What the factory exposes

Each call to `createFirestoreDataTools` returns these tool handlers:

- `firestore_get_document`, `firestore_list_documents`, `firestore_query_where`: reads.
- `firestore_create_document` (explicit path), `firestore_add_document` (auto-id, mirrors `addDoc`), `firestore_update_document`, `firestore_delete_document`: writes.
- `firestore_batch_write`: many `set` / `update` / `delete` in one call (seed / bulk-edit).

Every tool takes the optional `as` arg above (admin by default). The exact parameter schemas are surfaced through `@inbrowser/agent`'s standard `ToolHandler.parameters` (JSON Schema).

## Why a resolver, not a single Firestore handle

The resolver fires per-dispatch. A single Firestore handle baked into the factory would:

- Pin every tool call to one identity. The tool layer's `as` field would be ignored.
- Survive `sandbox.reset()` only if the handle is per-call-resolved through the sandbox (which `pyric/firestore`'s opaque handle doesn't expose).
- Force the host to re-register tools whenever the backend changes.

The resolver dodges all three. Hosts that only ever write as admin wire `() => adminDb` and the cost is one function call per dispatch.

## Schema clarity

The `as` argument has a proper JSONSchema shape (`'admin'` OR `{ uid, claims? }`), so an agent sees the contract in the tool description: bypass is `as: 'admin'`, rules-enforcement is `as: { uid }`. Without this, agents discover the auth model by trial and error: calling the rules-enforced path, getting denied, then inferring the admin path.

## Where to look next

- For tool registry and dispatch, see the `@inbrowser/agent` package.
