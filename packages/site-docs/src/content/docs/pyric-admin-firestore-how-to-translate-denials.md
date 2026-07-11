---
title: "How to translate denials with denialContext"
navLabel: "Translate denials"
group: "pyric-admin / firestore"
section: "How-to"
order: 170
---
# How to translate denials with `denialContext`

This guide shows you how to read the structured denial frame attached to every `permission-denied` error from `pyric-admin` operations.

## Catch with `instanceof`
```ts
import { SandboxError } from 'pyric-admin';

try {
  await bobDb.collection('notes').doc('n1').set({
    ownerId: 'alice',
    title: 'tamper',
  });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    const ctx = e.denialContext;
    console.log('Method:', ctx?.request?.method);
    console.log('Path:', ctx?.request?.path);
    console.log('Auth:', ctx?.auth);
    console.log('Why:', ctx?.reasons);
  } else {
    throw e;
  }
}
```
`SandboxError` is re-exported from `pyric/sandbox`, so you can import it directly from `pyric-admin`. The `instanceof` check is what TypeScript narrows on: `e.code` is then typed.

## What `denialContext` carries
```ts
interface DenialContext {
  auth?: AuthState;
  reasons?: string[];           // simulator debug messages
  request?: {
    method: 'get' | 'list' | 'create' | 'update' | 'delete';
    path: string;
    resourceData?: Record<string, unknown>;
  };
  resource?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  rule?: { line: number; expression: string };  // best-effort
  failedFields?: string[];                       // deferred
}
```
For a denied write:

- `request.method` = `create` / `update` / `delete`.
- `request.path` = the document path.
- `request.resourceData` = the resolved post-sentinel payload the rule saw.
- `resource.data` / `resource.exists` = the existing document state.
- `reasons` = the simulator's debug messages, one per rule evaluated.

For a denied read:

- `request.method` = `get` / `list`.
- `request.path` = the doc path or the collection path.
- `request.resourceData` is absent (reads carry no payload).
- `resource.data` / `resource.exists` reflect the doc being read (for `get`; absent for `list`).

## Render a "why did this deny" UI
```tsx
function DenialBanner({ error }: { error: SandboxError }) {
  if (error.code !== 'permission-denied') return null;
  const ctx = error.denialContext;
  return (
    <div className="banner banner-denied">
      <strong>{ctx?.request?.method} denied</strong> at <code>{ctx?.request?.path}</code>
      <details>
        <summary>Auth</summary>
        <pre>{JSON.stringify(ctx?.auth, null, 2)}</pre>
      </details>
      <details>
        <summary>Reasons ({ctx?.reasons?.length ?? 0})</summary>
        <ul>{ctx?.reasons?.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </details>
    </div>
  );
}
```
Real Firebase strips this context server-side for security. The sandbox can expose it because it's a development tool: every field is useful for debugging without leaking anything sensitive about the rules engine.

## Cross-listener denials

The same `denialContext` shape appears on `SnapshotErrorEvent` (the payload of `sandbox.onSnapshotError`). When a snapshot listener is silently terminated, the host-level callback receives the same fields plus a `target` discriminator (`{ kind: 'doc', path }` or `{ kind: 'query', collection }`).

This means one denial-UI component can render denials from anywhere (try/catch sites, listener errors, host channels) without translating between shapes.

## Where to look next

- For the `DenialContext` field-by-field reference, see Denial shapes in `pyric/sandbox`.
- For the difference between `SandboxError` codes, see [`SandboxError` codes](../pyric-sandbox-reference-error-codes/).
