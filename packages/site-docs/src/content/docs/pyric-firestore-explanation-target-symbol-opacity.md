---
title: "The TARGET_SYMBOL opacity contract"
navLabel: "TARGET_SYMBOL opacity"
group: "pyric / firestore"
section: "Explanation"
order: 92
---
# The `TARGET_SYMBOL` opacity contract

The public `Firestore` type has exactly one property:
```ts
interface Firestore {
  readonly [TARGET_SYMBOL]: Target;
}
```
`TARGET_SYMBOL` is a `unique symbol`. No string keys, no methods. This page explains the choice.

## What it accomplishes

Two related things.

### Backend-opaque handles

The handle's contents are an internal detail. Consumers never read `db.target` or `db.someInternalField` because there are none. Whether the backend is sandbox or prod, the handle looks identical from the outside.

### Forwards compatibility

Any property the package exposes becomes part of the public API. Removing or renaming it later is a breaking change. By exposing only `TARGET_SYMBOL`, the package keeps the freedom to restructure internals without affecting consumers.

The package's *free functions* take `db: Firestore` as an argument and read the symbol internally:
```ts
function targetOf(handle: Firestore): Target {
  return handle[TARGET_SYMBOL];
}
```
Consumers don't import `TARGET_SYMBOL`. They pass handles to functions that know how to use it.

## Why a `unique symbol`

Three options for the discriminator:

1. **String key**: `Firestore.target`. Discoverable through `Object.keys`, serialisable, readable by any consumer. Becomes API surface.
2. **Module-private state map**: a `WeakMap<Firestore, Target>` inside the package. Truly hidden, but consumers can't even reference the handle's shape, so type checks lose information.
3. **Unique symbol**: not enumerable through `Object.keys`, doesn't appear in JSON, but the type system can still reference it.

We picked (3) because it gives:

- Runtime invisibility (won't appear in `console.log`, serialisation, debuggers' default views).
- Type-level visibility (TypeScript knows the property exists, narrows correctly).
- No need for an external map (the handle is self-describing).

The symbol is `Symbol('pyric/firestore/target')`. The string description is for debugging (it shows up if you deliberately inspect the symbol), but no code branches on the description.

## What consumers can do with the handle

Pass it to functions. That's it. The intended usage:
```ts
const db = getFirestore(target);
doc(db, 'notes/n1');                // valid
setDoc(doc(db, 'notes/n1'), data);  // valid
db.doc;                              // type error
db.collection;                       // type error
db.toString();                       // works (inherited from Object), useless
```
Consumers that need to inspect the backend (debug logs, instrumentation) can:

- Track which path produced the handle and remember externally.
- Use a custom wrapper function that exposes the target.

Reading `[TARGET_SYMBOL]` directly from consumer code works but is unsupported. The symbol's shape may change between minor versions.

## Comparison with `pyric-admin`'s handle

`pyric-admin`'s `SandboxFirestore` is the opposite: a method-rich class that mirrors `firebase-admin/firestore`. Each handle exposes `.collection`, `.doc`, `.batch`, `.runTransaction`, plus the sandbox-only methods.

Why the different shape? Because each package mirrors a different upstream SDK. `firebase-admin/firestore` is chainable: methods on the handle. `firebase/firestore` is modular: free functions. The two `Firestore` types reflect their respective upstream conventions.

## Why this matters for the swap-in contract

The upstream `firebase/firestore`'s `Firestore` is similarly opaque. Application code that uses the modular SDK doesn't read properties off the handle; it passes the handle to functions. By matching that opacity, `pyric/firestore` is a drop-in replacement at the type level. Code that imports `Firestore` from `firebase/firestore` and code that imports it from `pyric/firestore` behaves the same way.

If we exposed a property on our `Firestore`, application code might start to depend on it. That code would then break the moment the handle came from `firebase/firestore` instead (or the other way around). Opacity is what keeps the swap boundary clean.

## When opacity gets in the way

A few cases where consumers want more:

- **Debugging** which backend a handle is bound to. Solution: track externally, or `console.log(JSON.stringify(db, Object.getOwnPropertySymbols(db).reduce(...)))` if you really want to see.
- **Logging** which path a request went through. Solution: instrument the call sites, not the handle.
- **Generic code** that wants to branch on backend. Solution: pass a flag alongside the handle. Don't sniff the handle.

The third case occasionally tempts engineers. Resist it. The backend-agnostic call surface is the point. Code that switches on the backend is a sign that the function should be split into two backend-specific implementations, not a sign that the handle should expose its target.
