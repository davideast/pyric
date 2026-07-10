# How to switch users with `withAuth`

This guide shows you how to evaluate rules under different auth identities against the same sandbox.

## Two contexts, one sandbox

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();

const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
const anonDb  = getFirestore(sandbox.withAuth(null));
```

Three contexts, three identities, shared data. Writes through `aliceDb` evaluate with `request.auth.uid == 'alice'`; reads through `adminDb` evaluate with `request.auth.token.admin == true`; everything through `anonDb` sees `request.auth == null`.

## Chain from a context

`SandboxContext.withAuth` replaces the auth and returns a new sibling context:

```ts
const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
const userCtx = adminCtx.withAuth({ uid: 'alice' });
// adminCtx and userCtx share the same sandbox but evaluate as different users.
```

Use this when a chunk of code already has a context and wants to derive another one without going back to the sandbox.

## Tokens are claims, not just JWTs

The `token` field on `AuthState` becomes `request.auth.token.*` in rules. Pass any custom claims your rules care about:

```ts
sandbox.withAuth({
  uid: 'employee-42',
  token: {
    org: 'acme',
    role: 'editor',
    plan: 'pro',
  },
});
```

Inside a rule:

```rules
allow update: if request.auth.token.role == 'editor'
              || request.auth.token.role == 'admin';
```

## Anonymous must be explicit

`withAuth(undefined)` throws `SandboxError('invalid-argument')`. For anonymous access, say `withAuth(null)` — the call site is then unambiguous about whether anonymous was intended or omitted.

## Invalid shapes

The validator rejects:

- `undefined` — say `withAuth(null)` for anonymous.
- Empty UID (`{ uid: '' }`) — UIDs must be non-empty strings.
- Non-string UID — `uid` must be a string.
- `token` set but not an object — `token` must be a plain object when present.

All four raise `SandboxError('invalid-argument')` with a `remediation` describing the fix.

## Per-operation auth isn't a thing

There are no per-operation `auth` overrides. Identity is exclusively a property of `SandboxContext`. To act as a different user, derive a different context — don't pass auth to the operation.

The reason is composability: a service handle (`FirestoreHandle` from `pyric-admin`) doesn't carry auth in its method signatures. The handle is bound to its context at construction. Adding per-call auth would either bypass that binding silently or require duplicating every method signature with an optional override; both are worse than "derive a new context".

## Where to look next

- For the `AuthState` shape, see [`Sandbox`, `SandboxContext`, `AuthState`](../reference/sandbox-and-context.md#authstate).
- For why identity lives on contexts, see [Identity is a context, not a sandbox](../explanation/identity-is-a-context.md).
