---
title: "Why this package exists"
group: "pyric / rules"
section: "Explanation"
order: 12027
---
# Why this package exists

Firestore Security Rules is a small DSL that sits between every read and write your app makes. In Pyric we have two distinct needs around that DSL:

1. A **data-plane** for the app code (`getDoc`, `setDoc`, `onSnapshot`, the modular Web SDK shape) that can be swapped between production Firestore and an in-process sandbox. This lives in `pyric/firestore`.

2. **Tooling around the rules themselves**: parsing them, linting them, simulating them, testing them. This is `pyric/rules`.

The split looks bureaucratic at first. Why not put both in one package? Two reasons:

## The swap-in surface must stay minimal

`pyric/firestore` is meant to be a drop-in replacement for `firebase/firestore`. Any host that imports it should see exactly the surface area that the upstream modular Web SDK exposes. No more, no less. Adding rules tooling to that import path would either pollute the swap-in surface (making the package look bigger than the production package it mirrors) or force consumers to import from non-standard sub-paths (which break tree-shaking and make TypeScript editor completion noisier than it needs to be).

The same reasoning shapes `pyric/rules` internally: the public front door (`firestoreRules`, `rtdbRules`, `lint`, the assertion adapters) is small on purpose, but the engine underneath it (the parser, `parseToAST`; the linter, `lintFirestoreRules`; the validator, `validateFirestoreRules`; the simulator, `SimulateFirestoreRulesHandler`; seven value wrappers; and a sentinel expression engine) is bigger than the production data-plane surface. Bundling all of that onto `pyric/firestore`'s root would dominate the swap-in package, which is why it stays behind `pyric/rules/internal` instead.

## The audiences are different

Most apps using `pyric/firestore` will never call any function in `pyric/rules`. The data-plane is consumed by feature code: components, hooks, server actions. The rules tooling is consumed by tooling code: CI scripts, lint hooks, deploy pipelines, agent runtimes. These audiences have different bundle-size sensitivities (a feature-code package has to pay for every dependency in every consumer's bundle; a tooling package only loads in CI) and different release cadences (the data plane changes when the Firestore Web SDK does; the rules tooling changes when we discover a new agent failure mode).

A clean split lets each side evolve at its own speed without burdening the other.

## What ends up here

Anything *about* rules:

- The parser that turns rules text into an AST.
- The linter that catches compilation limits, runtime-budget risks, and security anti-patterns.
- The validator that emits the `SEC` / `SEM` / `QUA` / `STR` finding codes.
- The modules resolver and stdlib.
- The local simulator (used by the sandbox and by agents).
- The Rules Test API client (used by CI and by agents).
- The value wrappers that model `Timestamp`, `Path`, `Bytes`, etc.
- The sentinel expression engine used by `pyric/sandbox` for declarative writes.
- The tool factories that wrap all of the above as `@inbrowser/agent` tool handlers.

## What stays out

The Firestore Web SDK surface stays in `pyric/firestore`. The control-plane primitives (deploy, scope) stay in `pyric-tools/deploy`. The sandbox itself (the `LocalEnvironment` that holds documents and listeners) stays in `pyric/sandbox`. These three packages and this one form a loose hexagon: data plane, rules tooling, control plane, sandbox. Each depends on a small surface of the others; none of them depends on a kitchen-sink package.

## Tradeoffs

The cost of the split is duplication risk: a value wrapper used by both the sandbox (for type coercion at read-time) and the rules simulator (for expression evaluation) has to live in exactly one of the two packages, and the other has to import it. We chose to put the wrappers here because the rules simulator is the source of truth for "what does Firestore think this value is". The sandbox imports `Timestamp`, `Vector`, `Reference` from `pyric/rules/internal` as a result, which creates a runtime cycle in workspace terms. The cycle is benign at build time (the two packages export non-overlapping symbols and TypeScript handles the resolution), but it does mean both have to be built in a specific order. We accepted that complexity over the alternatives: duplicating the wrapper classes, which would make `instanceof Timestamp` start lying, or shipping a third `pyric/firestore-values` package, which would split the wrappers from their evaluator and make the evaluation logic harder to reason about.
