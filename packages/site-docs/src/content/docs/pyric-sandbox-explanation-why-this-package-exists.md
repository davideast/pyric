---
title: "Why this package exists"
group: "pyric / sandbox"
section: "Explanation"
order: 14024
---
# Why this package exists

The Firebase Emulator Suite is a Google-provided tool that runs a local copy of Firestore (and other services) in a sub-process. It's the canonical answer to "I want to test without hitting production." It works, but only in environments that can spawn an emulator. `pyric/sandbox` is what happens when you can't.

## What the emulator does well

The Firebase Emulator Suite is bit-for-bit production. Same Firestore engine, same rules engine, same wire protocols. Tests written against the emulator and tests written against production differ only in their connection URL. If you have an environment that can run it (a developer laptop, a CI runner with Java installed, a container), it's a perfectly good choice.

It also covers more than this package does: full Auth flows, Realtime Database, Storage, Cloud Functions emulation. `pyric/sandbox` doesn't try to match that breadth.

## Where the emulator stops working

A handful of contexts don't have an emulator option:

- **Browser-side tools.** The playground we ship is a browser app. It needs to evaluate Firestore writes and rules in-page; spawning Java isn't possible.
- **Long-lived agent processes.** Spinning up an emulator per agent session is expensive (~5 seconds to boot, tens of MB of memory, port allocation). For an agent loop that runs hundreds of micro-sessions, this overhead dominates everything else the agent does.
- **Lightweight test suites.** A unit test that asserts "this rule denies this request" shouldn't need to boot a 250 MB JVM. The cost-benefit is bad when there are thousands of tests.
- **Environments with no sub-processes.** Some sandboxed CI runners, edge runtimes, and serverless contexts can run Node or a browser but can't spawn arbitrary binaries.

For each of these, `pyric/sandbox` is the alternative. In-process, browser-safe, ~1 ms cold start, single megabytes of memory.

## What `pyric/sandbox` is

A re-implementation of the data + rules portion of Firestore, in TypeScript, sized to fit the agent / playground / unit-test use cases:

- The document store is an in-memory `LocalState` map.
- The rules engine is `pyric/rules`' `SimulateFirestoreRulesHandler`, also browser-safe.
- The transaction system tracks reads and writes per-tx, detects read-after-write violations, projects post-write state for `getAfter()`.
- Snapshot listeners are first-class: doc and query listeners both implemented, including the production behaviour where stream errors silently terminate the listener.
- Field-value sentinels (`increment`, `serverTimestamp`, `arrayUnion`) are honoured by the rules engine and the data plane.

What it isn't:

- It isn't bit-for-bit production. The simulator has gaps (some namespace methods on wrapper types aren't modelled yet). It returns `'unsupported'` on those, distinct from `'denied'`. See the `UnsupportedError` discussion in `pyric/rules`.
- It isn't a network. There's no transport, no quota, no concurrent-connection model. Tests that need to exercise transport-level error codes (`'unavailable'`, `'aborted'` from contention) belong on the emulator or live Firestore.
- It isn't multi-service yet. Firestore is the only data plane today. Auth state is modelled (because rules need it) but no Auth API is exposed. Realtime Database, Storage, and Functions emulation are out of scope.

## Why a separate package, not bundled with an adapter

The substrate is shared between `pyric-admin` (Admin-SDK-shaped) and `pyric/firestore` (modular Web-SDK-shaped). Bundling it into either one would force consumers of the other to pull in surface they don't use. Splitting it lets each adapter stay narrowly-scoped to its own API shape, and lets a hypothetical third adapter (RTDB, Auth) plug in without disturbing the existing two.

The split also makes the surface boundary explicit. `pyric/sandbox`'s public API is `Sandbox`, `SandboxContext`, `SandboxError`, and the listener channels, nothing else. The data-plane operations (`getDoc`, `setDoc`, `collection`, etc.) belong to the adapters. The adapters reach into `pyric/sandbox/internal` for the substrate; consumers don't.

See [Why service adapters live in sibling packages](../pyric-sandbox-explanation-why-adapters-are-siblings/) for the longer version.

## When to reach for which

| Need | Reach for |
|---|---|
| Test rules in a unit test, no emulator allowed | `pyric/sandbox` + `pyric-admin` or `pyric/firestore` |
| Run an agent loop that evaluates many rules per second | `pyric/sandbox` |
| Render a sandboxed Firestore in a browser playground | `pyric/sandbox` |
| Test full Firestore semantics including transport behaviour | Firebase Emulator Suite |
| Cover Auth flows, RTDB, Storage, or Functions | Firebase Emulator Suite |
| Bit-for-bit production parity | Live Firestore (via `pyric/firestore` with the prod backend) |

For most of the use cases this stack targets, the sandbox is the right call. For the cases it doesn't cover, the emulator or live Firestore are the right call. The two coexist. Nothing about `pyric/sandbox` makes the emulator harder to use.
