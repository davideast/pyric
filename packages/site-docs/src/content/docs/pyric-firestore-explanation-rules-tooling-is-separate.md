---
title: "Why rules tooling lives on a sibling subpath"
navLabel: "Rules tooling is separate"
group: "pyric / firestore"
section: "Explanation"
order: 11015
---
# Why rules tooling lives on a sibling subpath

`pyric/firestore` is the Firebase-compatible sandbox data plane. The rules
parser, linter, simulator, validator, modules resolver, and value wrappers live
under `pyric/rules`. Firestore-specific sandbox controls live under
`pyric/sandbox/firestore`. The separation preserves clear package ownership.

## The principle

During an activated Pyric development run, package resolution maps the canonical
`firebase/firestore` import to `pyric/firestore`. In an inactive production run,
the import remains Firebase. The mirror therefore needs the same data-plane
shape: reads, writes, queries, and listeners. Rules tooling and sandbox controls
must not appear as extra members on that surface.

By keeping rules tooling in `pyric/rules`, the swap-in surface stays bit-faithful to the upstream. Code that imports from `pyric/firestore` looks exactly like code that imports from `firebase/firestore`. Code that needs rules tooling reaches one folder over.

## What lives where

| Surface | Package |
|---|---|
| `getDoc`, `setDoc`, `collection`, `query`, `onSnapshot`, ... | `pyric/firestore` |
| `FieldValue`, `Timestamp`, sentinels | `pyric/firestore` |
| `setRules`, `seedDocuments`, `snapshotDocuments`, `inspect` | `pyric/sandbox/firestore` |
| `firestoreRules`, `lint`, `assertCase`, `explainCase` | `pyric/rules` (public front door) |
| `parseToAST`, `lintFirestoreRules`, `validateFirestoreRules` | `pyric/rules/internal` |
| `SimulateFirestoreRulesHandler`, `TestFirestoreRulesHandler` | `pyric/rules/internal` |
| Stdlib (`auth`, `validation`, ... modules) | resolved via `pyric/rules/internal/node` |
| `Timestamp`, `Path`, `Bytes` (rules wrapper classes) | `pyric/rules/internal` |
| Tool factories for lint / simulate / test | `pyric/rules/internal/node` |
| Production rules release | `firebase-tools` / Console |

There's some name overlap: `Timestamp` is both a sentinel value (data plane) and a wrapper class (rules engine). The two share a wire format but are distinct types. Each package exports its own; converters bridge them when needed.

## When a consumer needs rules tooling

Three common cases:

- **Linting before ship.** `lint(source)` (public) returns every issue as a `RuleIssue[]`. Gate CI (and refuse to `firebase deploy`) on `severity: 'error'` findings; consumers running their own ship gate call the public `lint` explicitly.
- **Testing rules locally.** `firestoreRules(source).simulate(cases)` (public) runs rules against synthetic requests without deploying or hitting the network. Useful for unit tests of complex rule logic.
- **Inspecting rules programmatically.** `firestoreRules(source).toJSON()` (public) returns a typed tree consumers can walk for custom analysis; the internal `parseToAST(source)` (`pyric/rules/internal`) is available for callers that need the parser directly.

These belong to a different audience than the data-plane consumers. A web app rarely touches them; a CI pipeline or an agent does.

## What the sandbox-control subpath bridges

`setRules(sandbox, rules)` loads rules into the local Firestore environment owned
by that sandbox. The implementation path is:
```ts
setRules(sandbox, source) → LocalEnvironment.deployRules(source)
                          → lintFirestoreRules(source)
```
The control receives the owner rather than a Firestore handle. This lets one
sandbox own Firestore rules, documents, listeners, history, and diagnostics
without widening the data-plane API.

## What we get from the split

- `pyric/firestore` has one job: emulate Firebase's client Firestore surface
  against a sandbox.
- `pyric/rules` can evolve without adding exports to the package-selected data
  plane.
- `pyric/sandbox/firestore` makes controls discoverable while naming their
  sandbox ownership at the import site.
- `firebase-tools` / Console ships rules without depending on the data plane. CI pipelines pull only what they need.
- Consumers reach for exactly the surface they want by package name. The package name is the documentation.

The downside is exactly one: a beginner asking "where is the linter?" has to learn it lives in a different public subpath. That's a one-time cost (the README and docs point at it explicitly) versus the recurring cost of a kitchen-sink surface that complicates every other consumer's bundle.
