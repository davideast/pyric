# 0008: Clean the CLI scaffold and served-entry structure separately

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-14

## Findings

The app-registry review found three structural P2s in CLI code touched by this
PR:

- `packages/cli/src/cli/init-templates.ts` exceeds the 600-line limit and owns
  the web, Node, and static scaffold families plus their shared registry.
- `packages/cli/src/cli/serve.ts` exceeds the limit and combines configuration,
  seed/rules loading, SDK assets, HTTP/bridge/UI setup, and process lifecycle.
- The served SDK entry inventory is hand-maintained in bundler, namespace, and
  Vite-plugin representations. A new entry can therefore be built without also
  becoming reachable from every serving path.

These internal modules are not a compatibility surface to preserve. The npm
packages are pre-stable and have no known consumers that require the current
internal structure, so the target is the ratified one-concept/per-record
structure, not a permanent exception for the current shape.

## Decision for this PR

Clean these concerns in a dedicated structural change rather than mixing file
moves and registry redesign into the app/session behavior diff. This follows the
repository rule that mechanical restructuring and behavior changes remain
separately reviewable.

This disposition is limited to the three module-shape P2s above. It does not
waive missing served entries, incorrect aliases, leaked resources, scaffold
installation defects, or any app/session/SharedWorker behavior finding.

## Required cleanup

Before the next CLI scaffold or served-SDK feature climb:

1. Move each scaffold family to its own template record/module and compute the
   scaffold registry from those records.
2. Split `serve.ts` into resource owners for configuration/fixtures, SDK assets,
   HTTP/bridge/UI startup, and shutdown; keep the command entry as lifecycle
   orchestration only.
3. Define one descriptor record per served SDK entry and derive bundle entry
   keys, import-map URLs, and Vite aliases from that single inventory.
4. Add characterization tests before moving code, including a test proving all
   derived entry views contain exactly the same specifiers.
5. Preserve public CLI behavior and run the full CLI, browser, packaging, and
   npm/pnpm/Bun install gates after the mechanical cleanup.
