---
title: "Public API"
group: "pyric / sandbox"
section: "Reference"
order: 129
---
# Public API

Every symbol re-exported from `pyric/sandbox`. The `/internal` sub-path is documented separately — see [The `/internal` adapter protocol](../pyric-sandbox-reference-internal-protocol/).

## Entry point

### `initializeSandbox(config?: SandboxConfig): Sandbox`

Create a new sandbox with no identity attached. Pass `SandboxConfig` is reserved for future service-agnostic options; today it must be `{}` or omitted.
```ts
const sandbox = initializeSandbox();
```
Identity is **not** part of init. Derive a `SandboxContext` via `sandbox.withAuth(...)` before reaching for any service handle.

## Types

### `Sandbox`

The data + rules + lifecycle handle. Identity-agnostic by design.
```ts
interface Sandbox {
  withAuth(auth: AuthState): SandboxContext;
  onEvent(cb: (event: SandboxEvent) => void): () => void;
  history(): SandboxEvent[];
  readonly admin: SandboxAdmin;
  reset(): void;
  dispose(): void;
  snapshot(): SandboxSnapshot;
}
```
See [`Sandbox`, `SandboxContext`, `AuthState`](../pyric-sandbox-reference-sandbox-and-context/).

### `SandboxContext`

Immutable `(sandbox, auth)` pair. Service factories (`getFirestore` and friends) accept this.
```ts
interface SandboxContext {
  readonly sandbox: Sandbox;
  readonly auth: AuthState;
  withAuth(auth: AuthState): SandboxContext;
}
```
### `AuthState`
```ts
type AuthState = { uid: string; token?: Record<string, unknown> } | null;
```
`null` is anonymous. The `token` object becomes `request.auth.token` in rules.

### `SandboxConfig`

Reserved for future config (rules, seed data, multi-service options). Empty in v1.

### `SandboxSnapshot`

Coarse capture of every service's state:
```ts
interface SandboxSnapshot {
  firestore?: Record<string, unknown>;
  [service: string]: unknown;
}
```
### `SandboxAdmin`

Rule-bypass reads, exposed on `sandbox.admin`. Identity-agnostic by design.
```ts
interface SandboxAdmin {
  getDocument(path: string): unknown | null;
  listDocuments(prefix: string):
    { path: string; data: unknown; phantom?: true }[];
}
```
See [`SandboxSnapshot` and admin reads](../pyric-sandbox-reference-snapshot-and-admin/).

### `SandboxEvent`

Discriminated union of every event the sandbox emits to `onEvent` subscribers — six kinds covering rule evaluations, committed writes, snapshot deliveries, suppressed re-evals, listener lifecycle, and session boundaries. See [`SandboxEvent` reference](../pyric-sandbox-reference-sandbox-event/).

### `DenialContext`

Structured denial frame attached to `SandboxError` for `permission-denied` codes. Subset of the `kind: 'request'` event's fields, surfaced at the throw site for code paths that catch the error rather than subscribe to `onEvent`.

## Errors

### `class SandboxError extends Error`

Typed error family. Construct via either positional or options-bag form:
```ts
new SandboxError(code, message, denialContext?);
new SandboxError({ code, message, denialContext?, remediation? });
```
Properties:

- `code: SandboxErrorCode`
- `denialContext?: DenialContext` — populated for `permission-denied`.
- `remediation?: string` — optional human-readable guidance, appended to `.message`.

### `type SandboxErrorCode`
```
// Firebase-aligned
'invalid-argument' | 'permission-denied' | 'not-found' | 'already-exists'
'failed-precondition' | 'aborted' | 'unavailable'
// Sandbox-specific
'unimplemented' | 'not-seeded' | 'rules-not-loaded'
```
See [`SandboxError` codes](../pyric-sandbox-reference-error-codes/).

## Classes (for `instanceof` routing)

### `class SandboxContextImpl implements SandboxContext`

The concrete `SandboxContext` class. Exported so service factories can `instanceof`-check it. Consumers don't construct it directly — go through `sandbox.withAuth(...)`.

## What is not exported here

- `LocalEnvironment` and other adapter primitives live at `pyric/sandbox/internal`. See [The `/internal` adapter protocol](../pyric-sandbox-reference-internal-protocol/).
- Data-plane APIs (`getDoc`, `setDoc`, `collection`, transactions, etc.) live in `pyric-admin` and `pyric/firestore`.
- Rules tooling (parser, linter, simulator) lives in `pyric/rules`.
