---
title: "Why rules tooling lives in a sibling package"
navLabel: "Rules tooling is separate"
group: "pyric / firestore"
section: "Explanation"
order: 85
---
# Why rules tooling lives in a sibling package

`pyric/firestore` is the data plane. It doesn't ship the rules parser, the linter, the simulator, the validator, the modules resolver, or the value wrappers. Those live in `pyric/rules`. The split looks bureaucratic; the reason is the swap-in contract.

## The principle

`pyric/firestore` is meant to be a drop-in for `firebase/firestore`. The upstream package's surface is the data plane — reads, writes, queries, listeners. It does not include rules tooling. If `pyric/firestore` exposed rules tooling, the swap-in would have a wider surface than the package it replaces, and the migration story would no longer be "rename the import".

By keeping rules tooling in `pyric/rules`, the swap-in surface stays bit-faithful to the upstream. Code that imports from `pyric/firestore` looks exactly like code that imports from `firebase/firestore`. Code that needs rules tooling reaches one folder over.

## What lives where

| Surface | Package |
|---|---|
| `getDoc`, `setDoc`, `collection`, `query`, `onSnapshot`, ... | `pyric/firestore` |
| `FieldValue`, `Timestamp`, sentinels | `pyric/firestore` (re-exported from `pyric-admin`) |
| Sandbox-only ops (`sandbox.setRules`, `sandbox.seedDocuments`) | `pyric/firestore` (sandbox-only namespace) |
| `parseToAST`, `lintFirestoreRules`, `validateFirestoreRules` | `pyric/rules` |
| `SimulateFirestoreRulesHandler`, `TestFirestoreRulesHandler` | `pyric/rules` |
| Stdlib (`auth`, `validation`, ... modules) | `pyric/rules` |
| `Timestamp`, `Path`, `Bytes` (rules wrapper classes) | `pyric/rules` |
| Tool factories for lint / simulate / test | `pyric/rules` |
| `firestore.rules.deploy(scope, source)` | `pyric-tools/deploy` |

There's some name overlap: `Timestamp` is both a sentinel value (data plane) and a wrapper class (rules engine). The two share a wire format but are distinct types. Each package exports its own; converters bridge them when needed.

## When a consumer needs rules tooling

Three common cases:

- **Linting before deploy.** `lintFirestoreRules(source)` returns warnings and metrics. The deploy path in `pyric-tools/deploy` runs this internally; consumers running their own deploy gate run it explicitly.
- **Testing rules locally.** `SimulateFirestoreRulesHandler.simulate(source, testCases)` runs rules against synthetic requests without deploying or hitting the network. Useful for unit tests of complex rule logic.
- **Inspecting rules programmatically.** `parseToAST(source)` returns a typed tree consumers can walk for custom analysis.

These belong to a different audience than the data-plane consumers. A web app rarely touches them; a CI pipeline or an agent does.

## What the sandbox-only namespace bridges

`pyric/firestore`'s `sandbox.setRules(db, rules)` *does* deploy rules — but only to a sandbox-backed handle's underlying `LocalEnvironment`. The implementation under the hood:
```ts
sandbox.setRules(db, source) → pyric-admin's handle.setRules(source)
                               → LocalEnvironment.deployRules(source)
                               → lintFirestoreRules(source) (from pyric/rules)
```
The lint result returned to the consumer comes from `pyric/rules`. The data-plane package depends on the rules-tooling package transitively — but doesn't re-export it.

## When the cycle matters

`pyric/sandbox` imports the rules simulator from `pyric/rules` to evaluate rules against operations. `pyric/rules` imports `LocalEnvironment` (type-only) from `pyric/sandbox` for its tool-factory shape. A runtime cycle.

`pyric/firestore` sits on top of both. It depends on `pyric-admin` (which depends on `pyric/sandbox`) and indirectly on `pyric/rules` (through `pyric/sandbox`). It doesn't depend on `pyric/rules` directly — the sandbox-only namespace's lint output is whatever the underlying `LocalEnvironment.deployRules` returns.

The cycle is benign. Documented loudly. The module direction is `rules` → `sandbox` → `admin` → `firestore`.

## What we get from the split

- `pyric/firestore` is small. The package wraps a few hundred functions over two backends; its dependency graph is bounded.
- `pyric/rules` can evolve independently. New lint rules, new simulator features, new validator codes — none affect `pyric/firestore`'s surface.
- `pyric-tools/deploy` deploys rules without depending on the data plane. CI pipelines pull only what they need.
- Consumers reach for exactly the surface they want by package name. The package name is the documentation.

The downside is exactly one: a beginner asking "where is the linter?" has to learn it lives in a different public subpath. That's a one-time cost — the README and docs point at it explicitly — versus the recurring cost of a kitchen-sink surface that complicates every other consumer's bundle.
