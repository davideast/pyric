---
title: "Sandbox, SandboxContext, AuthState"
navLabel: "Sandbox and context"
group: "pyric / sandbox"
section: "Reference"
order: 136
---
# `Sandbox`, `SandboxContext`, `AuthState`

The three core types. Every other surface in the package builds on them.

## `Sandbox`

The data + rules + lifecycle handle.
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
A `Sandbox` is **identity-agnostic**. It does not know who you are — that's what `SandboxContext` is for. The `Sandbox` only holds:

- The current `LocalEnvironment` (documents, rules, listeners).
- The `onEvent` subscriber registry (survives `reset()`).
- Lifecycle methods (`reset`, `dispose`).

Construct via `initializeSandbox()`. Custom implementations are not supported — adapter packages use `instanceof` checks to route, and pass through `getInternalEnv` (from `pyric/sandbox/internal`) which throws on non-`SandboxImpl` handles.

### `withAuth(auth)`

Derive a `SandboxContext` bound to this sandbox under the given auth identity.
```ts
const aliceCtx = sandbox.withAuth({ uid: 'alice' });
const adminCtx = sandbox.withAuth({ uid: 'admin', token: { role: 'admin' } });
const anonCtx  = sandbox.withAuth(null);
```
`undefined` is rejected — say `withAuth(null)` for anonymous explicitly so the call site is unambiguous. Empty UIDs are rejected. Non-object `token` is rejected. See the [error-handling notes](../pyric-sandbox-reference-error-codes/#invalid-argument) for the exact rules.

### `onEvent(cb)`

Subscribe to every observable event the sandbox emits — see [`SandboxEvent`](../pyric-sandbox-reference-sandbox-event/) for the discriminated-union shape. One subscription covers requests, committed writes, snapshot deliveries, suppressed re-evals, listener lifecycle, and reset / dispose boundaries. Filter on `event.kind` to recover individual streams; see the [filter cookbook](../pyric-sandbox-reference-sandbox-event/#filter-cookbook).

Survives `sandbox.reset()` — the registry lives on the sandbox, not on the underlying environment, so the env swap doesn't invalidate live subscribers. A `session_boundary` event with `phase: 'reset'` fires immediately before the swap so consumers can segment a persisted stream.

Returns an unsubscribe function. Listener throws (sync) and async-promise rejections are swallowed so a faulty subscriber can't change rule semantics, hide other events, or crash the process via `unhandledRejection`.

### `history()`

Every [`SandboxEvent`](../pyric-sandbox-reference-sandbox-event/) this sandbox has emitted since init or the last `reset()`. Returns a defensive copy — mutating the result doesn't affect future calls.

Unlike `onEvent`, which is a live stream from the moment of subscribe, `history()` returns *every* event the sandbox has seen. Use it for:

- **Replay**: hand the array to `replay(events, rules)` from `pyric/sandbox` and the engine re-issues every captured write against a fresh sandbox. See [Replay a captured event stream](../pyric-sandbox-how-to-replay-events/).
- **Late subscribers**: consumers that load a saved session before subscribing read the full pre-subscribe history.
- **Snapshot-at-moment persistence**: capture the array, persist it, hand it back to `replay()` later.

`reset()` emits a closing `session_boundary` event, then clears the internal history. Consumers that snapshotted *before* the reset retain the boundary as the final entry. `dispose()` leaves the boundary as the final entry and doesn't clear (the sandbox is dead either way).

v1 doesn't cap the history. Long-running sandboxes accumulate; snapshot + `reset()` to roll over if memory becomes an issue.

### `admin`

Rule-bypass reads for test assertions. See [`SandboxSnapshot` and admin reads](../pyric-sandbox-reference-snapshot-and-admin/). Surfaced only on the root sandbox — admin reads are identity-agnostic, so presenting them on a context (which exists to carry identity) is conceptually muddled.

### `reset()`

Wipe data, rules, and any service-specific configuration. Replaces the underlying environment with a fresh one.

Snapshot listeners on the OLD environment are dropped at the swap — their target docs have been wiped, so they can't survive. `onEvent` subscribers DO survive — the registry lives on the sandbox itself, and a `session_boundary` event with `phase: 'reset'` fires before the swap so observers know the rollover happened. Existing `SandboxContext`s continue to work — their sandbox reference is stable; subsequent operations resolve to the new environment.

### `dispose()`

Drop listener registries on this sandbox's environment without replacing it. Use this when you're about to discard the sandbox itself. Idempotent. Does not touch data.

### `snapshot()`

Capture a typed snapshot of every service's state. v1 carries only `firestore`; future services add their own keys.

## `SandboxContext`
```ts
interface SandboxContext {
  readonly sandbox: Sandbox;
  readonly auth: AuthState;
  withAuth(auth: AuthState): SandboxContext;
}
```
A `(sandbox, auth)` pair. Cheap to create, immutable, freely shareable. Service factories require this — passing a bare `Sandbox` is a type error.

Many contexts can coexist for one sandbox. Data is shared; rules evaluate per-context under the context's auth identity.

### Chaining
```ts
const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
const userCtx = adminCtx.withAuth({ uid: 'alice' });
```
`SandboxContext.withAuth` **replaces** auth, it does not merge. The new context carries only the new auth.

## `AuthState`
```ts
type AuthState =
  | { uid: string; token?: Record<string, unknown> }
  | null;
```
- `null` → unauthenticated; `request.auth` evaluates to `null` in rules.
- `{ uid }` → authenticated; `request.auth.uid` carries the value.
- `{ uid, token }` → authenticated with custom claims; `request.auth.token.<key>` carries each entry.

The same shape feeds the rules simulator's `TestCase.auth` field (`pyric/rules`), so test data written against one surface works with the other.

## Lifecycle in pictures
```
initializeSandbox()
       │
       ▼
   ┌───────┐  withAuth({uid: 'alice'})    ┌─────────────┐
   │       │ ───────────────────────────▶ │ ctx (alice) │ ──▶ getFirestore(ctx) ──▶ FirestoreHandle
   │ Sand- │                              └─────────────┘
   │ box   │  withAuth(null)              ┌─────────────┐
   │       │ ───────────────────────────▶ │ ctx (anon)  │ ──▶ getFirestore(ctx) ──▶ FirestoreHandle
   └───────┘                              └─────────────┘
       │
       │  reset() — swaps env, drops listeners; contexts still work
       │
       ▼
   ┌───────┐
   │ Sand- │  ← same sandbox, new env underneath
   │ box   │
   └───────┘
```
The sandbox object identity is stable for the life of the consumer — only the underlying environment swaps. Contexts holding references to the sandbox don't need to be re-derived after a `reset`.
