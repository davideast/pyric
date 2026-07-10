---
title: "Why no firebase CLI dependency"
navLabel: "Why no Firebase CLI"
group: "pyric-tools / deploy"
section: "Explanation"
order: 72
---
# Why no `firebase` CLI dependency

`pyric-tools/deploy` deliberately doesn't shell out to the `firebase` CLI. This page explains the tradeoffs.

## What the CLI does well

The `firebase` CLI is excellent at interactive deploys. You run `firebase deploy --only functions`, it reads your `firebase.json`, asks for confirmation on destructive operations, prints a progress UI, and exits with a useful status. For a developer pushing a change from a laptop, that's exactly the right shape.

It is also the canonical reference for what "a Firebase deploy" means: every edge case (rewrites validated at finalize, function operations as long-running tasks, ruleset two-step create-then-release) has been encoded into the CLI's behaviour over years.

Where the CLI struggles is everywhere a deploy isn't being run by a human from a shell.

## What we needed instead

The agent runtimes, deploy bots, and browser-side UIs that consume `pyric-tools/deploy` all need:

- **Programmatic access.** The CLI's stdout is human-readable and changes between versions. Parsing it to drive logic downstream is fragile.
- **In-process execution.** Spawning a subprocess per deploy is fine on a developer laptop and expensive in a long-running daemon.
- **Browser support.** The CLI is Node-only. A browser-side agent can't shell out.
- **Structured errors.** "The deploy failed because the rewrite target wasn't deployed yet" is a different problem from "the deploy failed because IAM rejected the create". The CLI surfaces both as exit-code 1 with a string.
- **Composable surfaces.** An agent might want to deploy rules but not functions; do a dry-run; check status without deploying. The CLI's verbs don't always factor that finely.

These aren't problems with the CLI. They're problems with using the CLI from a non-CLI context.

## Re-implementing instead of wrapping

We considered wrapping the CLI. Spawn the subprocess, parse output, surface as a typed API. The exercise failed:

- The CLI is updated frequently and changes output format without ceremony. A wrapper would break on every minor version.
- Error states aren't enumerated anywhere we can rely on. We'd be matching on prose and hoping the prose stayed stable.
- The 50 MB+ install footprint can't be carried into a browser bundle even partially.

So the alternative was to re-implement, against the same REST APIs the CLI is built on. Those APIs *are* documented, versioned, and stable. The mechanical surface for "deploy a function" or "create an index" is small enough that re-implementation cost is bounded.

The current package is the result. Where the CLI does five REST calls to deploy a Hosting site, `hosting.deployFiles` makes the same five calls. The wire shapes are the same. The operations are the same. Only the interface changes: TypeScript functions instead of CLI subcommands.

## What we lose

A few things the CLI does that this package doesn't:

- **Interactive confirmation.** A CLI deploy can prompt before destructive operations. Our primitives do exactly what they're told. Callers that want confirmation build their own UI on top.
- **Project config files.** The CLI reads `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `.firebaserc`. Our package takes scope and source as function arguments. Callers that want config-file-driven deploys parse the files themselves and call us with the results.
- **Emulator integration.** The CLI knows about the local Firebase Emulator Suite. Our package targets production endpoints only. The sandbox (`pyric/sandbox`) plays the local-emulator role in our stack.
- **Cross-product flows.** The CLI's `firebase deploy` does Hosting + Functions + Firestore in one verb. Our package exposes them separately, and callers compose them.

None of these are dealbreakers for the consumers we target. Most are features for those consumers: an agent doesn't *want* an interactive prompt, an in-process script doesn't *want* a separate config file.

## What we gain

The package is small, dependency-light, browser-safe, and shaped for the consumers we have. The price is owning the mechanical surface: when Google adds a new field to the Hosting API, we add it to our types instead of waiting for the CLI to ship it. So far, that's been a worthwhile trade.
