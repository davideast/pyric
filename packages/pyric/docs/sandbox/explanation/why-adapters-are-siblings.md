---
navLabel: "Why adapters are siblings"
---
# Why service adapters live in sibling packages

`pyric/sandbox` doesn't ship the data-plane API. The functions you actually call (`getDoc`, `setDoc`, `collection`, `onSnapshot`, `runTransaction`) live in `pyric-admin` (Admin-SDK-shaped) and `pyric/firestore` (modular Web-SDK-shaped). This page explains why.

## Two production shapes, one substrate

Firebase ships two Firestore SDKs that look quite different up close. Server / Admin / Cloud Functions code uses `firebase-admin/firestore`: chainable methods, class-shaped query builders, instance-bound operations. Browser / mobile / React Native code uses `firebase/firestore`: modular functions, function-bound queries, tree-shakable imports.

Both are good APIs. Neither is a superset of the other. A package targeting both audiences has two reasonable choices:

1. Pick one shape, force the other audience to translate.
2. Ship both shapes over a shared substrate.

We picked (2). The shared substrate is `pyric/sandbox`; the two shapes are `pyric-admin` and `pyric/firestore`.

## Why not bundle everything

A monorepo with one big `pyric/sandbox` that includes both APIs would work, mechanically. The reason not to is bundle cost and conceptual clutter.

### Bundle cost

A browser app that uses the modular Web SDK does not want the Admin-SDK shape in its bundle. These are more than different APIs. They have different opinions about what `Query` is, what a transaction's read/write API looks like, what reference identity means. If both surfaces live in one package, tree-shaking has to be perfect to avoid pulling in the unused shape. Tree-shaking in practice is "almost perfect", and "almost" hurts.

Splitting into separate packages means the bundler doesn't have to be clever. The browser app imports `pyric/firestore`, and that's all the bundler sees.

### Conceptual clutter

The substrate's API surface (`Sandbox`, `SandboxContext`, listeners, lifecycle, error family) is small and stable. The data-plane API surfaces are large and follow upstream SDKs. Mixing them in one package would either bury the substrate in a sea of `getDoc`/`setDoc` exports or split into namespaces inside one package, which is sibling packages with extra steps.

Keeping the split visible at the package level makes the dependency direction obvious: the data planes depend on the substrate, never the other way around.

## What the adapters do

Both adapters are thin. The pattern, abstracted:

```
User call (getDoc, db.collection.get, etc.)
  ↓
Adapter translates to a generic Operation { method, path, auth, data? }
  ↓
LocalEnvironment.execute(operation)
  ↓
Simulator + LocalState + EventLog
  ↓
OperationResult { allowed, data?, debugMessages, event }
  ↓
Adapter translates back to user-facing types (QuerySnapshot, DocumentSnapshot, etc.)
```

The adapter is mostly translation. Each one does a few extra things to match its upstream SDK's idiosyncrasies (`pyric-admin` constructs a per-call compatibility implementation to keep reference semantics right; `pyric/firestore` adapts the modular Web SDK shape), but the core flow is the same.

This is what makes "the substrate is shared" workable. Both adapters bottom out at the same `LocalEnvironment` methods. Two contexts derived from one sandbox, one through `pyric-admin` and one through `pyric/firestore`, see the same data.

## What lives where

| Symbol / behaviour | Package |
|---|---|
| `Sandbox`, `SandboxContext`, `withAuth` | `pyric/sandbox` |
| `SandboxError`, denial channels | `pyric/sandbox` |
| `LocalEnvironment` (raw substrate) | `pyric/sandbox/internal` |
| Admin-SDK-shaped Firestore API | `pyric-admin` |
| Modular Web SDK-shaped Firestore API | `pyric/firestore` |
| Rules parser, linter, simulator | `pyric/rules/internal` |
| Credentials for Rules Test API / verify | `@pyric/cli/credentials/node` |
| Production shipping (rules, indexes, hosting, functions) | `firebase-tools` / Console |

The rule of thumb: anything *shape-agnostic* (the data, the rules, the lifecycle) lives in the substrate; anything *shape-specific* lives in an adapter.

## The runtime cycle

`pyric/sandbox` imports the rules simulator from `pyric/rules/internal`. `pyric/rules` imports `LocalEnvironment` (type-only) from `pyric/sandbox/internal`. This is a module cycle inside the package graph.

The cycle is benign: the import from `pyric/rules/internal` into `pyric/sandbox` supplies the rules engine and value wrappers; the import from `pyric/sandbox` back into `pyric/rules` is type-only. Neither side is in the other's runtime call graph beyond what is documented.

We accepted the cycle because the alternative, duplicating wrapper classes in both packages, would make `instanceof Timestamp` start lying depending on which copy was imported. The substrate consuming the simulator's wrapper types is the canonical path.

## Future adapters

The same pattern extends to other services. Hypothetical `pyric/auth` would:

- Depend on `pyric/sandbox`.
- Add an `Auth` service handle.
- Track auth state inside a future multi-service `LocalEnvironment`.
- Surface user-management APIs (`createUser`, `updateUser`) in the shape of `firebase-admin/auth` or `firebase/auth`.

The substrate would need a multi-service split inside `LocalEnvironment` (currently Firestore-only) and the adapter would slot in.

Same for `pyric/database` (Realtime Database) and `pyric/storage` (Cloud Storage). `pyric/storage` already exists for the storage data plane; its admin surface (`provisionStorage`, CORS helpers) lives on `pyric/storage`. Production Storage setup for real projects prefers `firebase-tools` / Console.

The point of the sibling-package shape is that each new adapter is a contained addition. Nobody who already uses `pyric-admin` cares when `pyric/database` lands; the substrate gets a new service slot but the existing adapter surface doesn't move.
