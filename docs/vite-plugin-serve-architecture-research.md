# Vite plugin / serve architecture research

**Investigated:** 2026-07-21 at `3011b4ccd62cad949deba0cd96871d91f9759fbd`

**Question:** What first-party evidence should constrain a maintainability refactor of `packages/cli/src/serve/vite-plugin.ts`, especially one intended to share code with `pyric dev`?

**Primary sources:** Vite's official documentation and source, this repository's source, ADRs, priorities, tests, and Git history.

## Conclusion

Keep the Vite plugin as the Vite **adapter**, but move construction and ownership of a running Pyric sandbox session behind one shared, host-neutral **module** used by both the Vite adapter and the `pyric dev` adapter.

The evidence does **not** support merging the two hosts or wrapping one in the other. Vite owns module resolution, dependency optimization, HTML transformation, its watcher, middleware ordering, and sometimes the HTTP server. `pyric dev` owns static hosting, import-map injection, port scanning, CLI output, process signals, and child-command orchestration. Those are real separate adapters. The duplicated middle is the session: project/rules loading, seed and persistent-state preparation, capture, Studio storage, `/__pyric` namespace, bridge, activity reporting, runtime payload, and owned-resource disposal.

This passes the repository's Refactoring and Tech Debt test in [`PRIORITIES.md`](../PRIORITIES.md): the maintenance friction is demonstrated by repeated parallel edits and by comments that explicitly describe copied behavior. It also executes the accepted direction in [ADR-0008](decisions/0008-cli-serve-structure-cleanup-follow-up.md), which requires resource owners for configuration/fixtures, SDK assets, HTTP/bridge/UI startup, and shutdown while leaving the command as lifecycle orchestration.

## Vite contracts that constrain the adapter

The package supports Vite 5, 6, and 7, rather than one implementation version ([CLI manifest](../packages/cli/package.json#L127-L143)). The refactor should therefore stay on documented plugin and dev-server contracts rather than Vite internals.

1. `config` is the pre-resolution hook for returning a partial configuration; `configResolved` receives the final configuration. That matches the current optimizer, build-target, environment, and `server.fs.allow` work and argues for leaving it in the Vite adapter. [Vite 6 Plugin API — `config` and `configResolved`](https://v6.vite.dev/guide/api-plugin#config)
2. `resolveId` and `load` are request-time plugin hooks, and Vite warns that an importer's shape is not always uniform. Pyric's Firebase swap and importer-scoped Node shims therefore belong to the adapter and should continue to be tested through Vite. [Vite 6 Plugin API — universal hooks](https://v6.vite.dev/guide/api-plugin#universal-hooks)
3. `configureServer` is an async, sequential hook intended for attaching Connect middleware. A returned function means “install post middleware”; it is **not** a disposer. The current plugin correctly mounts its guarded `/__pyric` middleware directly because it must run independently of Vite's internal middleware ordering. [Vite 6 Plugin API — `configureServer`](https://v6.vite.dev/guide/api-plugin#configureserver)
4. `transformIndexHtml` can return tag descriptors, and `order: 'pre'` is the supported way to send injected scripts through Vite's pipeline. Pyric's sandbox marker, init entry, runtime chip, and build chunk integration remain Vite-adapter work. [Vite 6 Plugin API — `transformIndexHtml`](https://v6.vite.dev/guide/api-plugin#transformindexhtml)
5. `ViteDevServer.httpServer` is explicitly null in middleware mode, while `middlewares`, `watcher`, and `close()` remain dev-server contracts. A shared session cannot assume it owns a Node HTTP server; bridge upgrades and listen-address-dependent functions must be optional host capabilities. [Vite 6 JavaScript API — `ViteDevServer`](https://v6.vite.dev/guide/api-javascript#vitedevserver)
6. Vite documents that `buildEnd` and `closeBundle` run when the dev server closes. Vite 5.4.21 source shows `server.close()` concurrently closing the watcher, hot channel, plugin container, dependency optimizers, and HTTP server; closing the plugin container is what drives plugin close hooks even in middleware mode. This is a stronger lifecycle signal than listening only to `httpServer.close`. [Vite 6 Plugin API — dev lifecycle](https://v6.vite.dev/guide/api-plugin#universal-hooks), [Vite 5.4.21 server source](https://github.com/vitejs/vite/blob/v5.4.21/packages/vite/src/node/server/index.ts)

### Lifecycle implication

The Vite adapter should own one idempotent session disposer and invoke it from `closeBundle`; an `httpServer.close` listener may remain only as a defensive compatibility path if tests prove it necessary. Resource cleanup must not depend exclusively on `httpServer`, because official Vite types make it null in middleware mode. Any Vite watcher handlers registered for rules or Functions hot reload need matching removal in that disposer.

## Repository evidence: the duplicated middle

Both public entry points already call the same low-level modules, but each still assembles the session independently:

| Session concern | `pyric dev` | Vite plugin |
|---|---|---|
| Firestore/RTDB/Storage rules | [`startServe`](../packages/cli/src/cli/serve.ts#L166-L232) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L425-L449) |
| Capture, persistence, fresh-state validation | [`startServe`](../packages/cli/src/cli/serve.ts#L240-L257) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L451-L471) |
| Seed/state-envelope decoding | [`startServe`](../packages/cli/src/cli/serve.ts#L259-L310) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L473-L510) |
| Bridge mount and project identity | [`startServe`](../packages/cli/src/cli/serve.ts#L340-L379) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L524-L569) |
| Event hub, Studio stores, site tree, namespace | [`startServe`](../packages/cli/src/cli/serve.ts#L382-L432) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L571-L657) |
| Functions discovery/child lifecycle | [`runServe`](../packages/cli/src/cli/serve.ts#L650-L840) | [`configureServer`](../packages/cli/src/serve/vite-plugin.ts#L524-L545) and its later child block |

This is more than shared imports. The plugin's comments say “Reproduce serve's rules prelude,” “mirrors serve's startServe orchestration,” “Ported from serve.ts,” and “mirrors serve.ts.” Those are first-party admissions that the interface is too low-level: callers reuse primitives but must still know the same ordering and precedence rules.

At the investigation commit:

- `vite-plugin.ts` is 1,077 lines and `serve.ts` is 984 lines.
- `configureServer` begins at line 425 and the HTML/build hooks resume at line 1,010: roughly 585 lines of the plugin are dev-session assembly.
- Since 2026-07-13, Git history shows at least 17 commits touching the Vite plugin; several cross-cutting behavior changes edited both adapters (Studio/docs, worker status, storage project scope, activity guard, and app registry), while Functions support landed once in `serve.ts` and later required two substantial Vite-plugin folds. Reproduce with:

```bash
git log --since=2026-07-13 --numstat --format='commit %h %ad %s' --date=short -- \
  packages/cli/src/serve/vite-plugin.ts packages/cli/src/cli/serve.ts
```

The deletion test points at the orchestration, not the existing low-level modules: deleting `state-store.ts`, `capture-store.ts`, `namespace.ts`, or `bridge-mount.ts` would concentrate real complexity. Deleting the duplicated assembly from either adapter would mostly move it to the other. The deepening opportunity is one module that owns assembly order and resource lifetime. This research stops short of designing that module's interface; the architecture review's grilling step comes first.

## Where sharing should stop

The following Vite responsibilities should remain local to `vite-plugin.ts`:

- `apply`, `config`, and `configResolved` policy;
- Firebase resolution and Node-shim `resolveId`/`load` hooks;
- dependency-optimizer esbuild integration;
- SharedWorker bundle preparation through the existing `vite-worker-runtime` module;
- adaptation of Vite's Connect request shape and DNS-rebinding inputs;
- adaptation of `server.watcher` changes into shared reload operations;
- optional upgrade/listening capabilities from `server.httpServer`; and
- build-only chunk emission plus `transformIndexHtml` tags.

The following `pyric dev` responsibilities should remain local to the CLI/static-server adapter:

- hosting/public-directory selection and inlined-Firebase scan;
- SDK/static asset materialization and import-map HTML injection;
- port scan, standalone packaging behavior, and terminal banner/JSON output;
- signal handling, auto-open, developer child-command orchestration, and process guard; and
- static-server shutdown.

Trying to share these would create a shallow abstraction full of Vite-or-static conditionals. One adapter per host is a real seam because two hosts already exist; the shared module should contain only the session semantics both adapters currently duplicate.

## Recommended architecture direction

Use three layers:

```text
Vite adapter                           static/CLI adapter
resolution, optimizer, HTML,          assets, hosting, import map,
Connect + watcher adaptation          ports, process + child lifecycle
              \                         /
               \                       /
                shared sandbox-session module
                project configuration + fixtures
                rules/live payload + stores + Studio
                namespace + bridge + resource disposal
                           |
                 existing focused modules
```

The shared module should be deep and own the ordering invariants that currently leak into both adapters:

- validate `fresh` against persistence and eagerly validate existing state;
- decode seed fixtures once, with “lived state wins” precedence;
- load the three rules families and construct the live init payload;
- decide whether Functions require a bridge and resolve project identity once;
- construct capture/state/Studio/event/namespace resources together; and
- dispose bridge pointers, child processes, subscriptions, and other owned resources once.

Keep watcher selection outside: the CLI adapter uses `watchProjectRules`; the Vite adapter uses Vite's watcher. Share the last-good rules behavior, not the mechanism that observes the filesystem. Keep host attachment and listen-dependent behavior in each adapter.

## Implementation outcome

The subsequent design passes kept the recommended three-layer shape and
narrowed the shared boundary where the host contracts demanded it. The
implemented `sandbox-session` module owns rules loading and last-good
replacement, seed and persistence precedence, capture, Studio stores, the live
init payload, the `/__pyric` namespace, SSE clients, and idempotent session
cleanup. Both the static/CLI adapter and the Vite adapter construct that same
module.

Bridge construction and Functions lifecycle remain adapter-owned. They need
host facts that are intentionally absent from the session interface: bound HTTP
servers and upgrade attachment, discovery pointers, Vite's watcher, child
processes, and the bridge's live `sandboxConnected` state. Moving them into the
session would widen the interface into a host abstraction and make the module
shallower. The session instead accepts only the late-bound bridge URL needed by
the init payload; each adapter composes the bridge handler ahead of the shared
namespace handler.

The Vite adapter now owns one active sandbox generation. Each transition
captures the current generation, clears the configured reference, closes the
captured generation, and publishes its replacement only after successful
construction. There is deliberately no mutation-hiding `closeActiveSession()`
helper. `closeBundle` provides the middleware-mode lifecycle signal, where
`httpServer` is null.

The plugin is also split by independent change family. `vite-plugin.ts` is a
stable composition root; module swapping, page/build state, and active sandbox
generation live behind separate interfaces. Generation retains one external
create/close interface while its Vite-specific bridge, Functions, middleware,
and rules-watcher adapters live in separate concept files. This keeps lifecycle
ordering explicit without making unrelated feature pull requests edit the same
implementation file.

## Maintainer change map

This is reference information for routing a change to its owning module and
test. A feature change should normally touch one row. The composition roots
change only when a new concern or Vite hook is introduced.

| Change | Production module | Primary test |
|---|---|---|
| Firebase import swap, Node shim, optimiser, filesystem allow-list | `packages/cli/src/serve/vite-module-swap.ts` | `packages/cli/test/serve/vite-module-swap.test.ts` |
| Build gating, emitted init chunk, HTML/runtime tags, page AI bootstrap | `packages/cli/src/serve/vite-page-runtime.ts` | `packages/cli/test/serve/vite-page-runtime.test.ts` |
| Active-generation replacement and rollback ordering | `packages/cli/src/serve/vite-sandbox-generation.ts` | `packages/cli/test/serve/vite-sandbox-generation.test.ts` |
| Bridge creation and Vite HTTP-server attachment | `packages/cli/src/serve/vite-generation-bridge.ts` | bridge cases in `vite-plugin-generation.test.ts` and `vite-plugin-bridge-e2e.test.ts` |
| Functions discovery and child attachment | `packages/cli/src/serve/vite-generation-functions.ts` | `packages/cli/test/serve/vite-plugin-functions.test.ts` |
| Connect adaptation and DNS-rebinding guard | `packages/cli/src/serve/vite-generation-middleware.ts` | middleware cases in `vite-plugin-integration.test.ts` |
| Vite watcher adaptation for rules reload | `packages/cli/src/serve/vite-generation-rules-watch.ts` | reload/listener cases in `vite-plugin-integration.test.ts` |
| Public plugin options or hook composition | `packages/cli/src/serve/vite-plugin.ts` | the owning family test plus `vite-plugin-integration.test.ts` when composition changes |

Internal modules are imported directly; do not add an internal barrel or a
hand-maintained feature registry. Keep detailed behaviour assertions in the
owning test file and reserve `vite-plugin-integration.test.ts` for contracts
between hook families.

## Verification implications

The current tests are already organized around observable adapter behavior (`packages/cli/test/serve/vite-plugin*.test.ts`, `server.test.ts`, bridge tests, rules tests, persistence tests). Preserve them as characterization tests. Add a smaller shared-session suite for ordering and cleanup invariants, then keep at least these adapter-level checks:

- Vite 5/6/7 type/build compatibility and a real dev-server smoke;
- middleware mode with `httpServer === null`, including cleanup through `server.close()`;
- normal Vite close and restart do not retain watcher listeners, discovery pointers, bridge upgrades, or Functions children;
- `/__pyric` middleware remains before Vite internals and independently host-guarded;
- sandbox build versus production build behavior and HTML tags remain unchanged; and
- `pyric dev` and Vite produce equivalent init payload semantics for the same rules, seed, persist, capture, Studio, bridge, and AI inputs.

## Sources

- [Repository priorities](../PRIORITIES.md)
- [Repository context](../CONTEXT.md)
- [ADR-0008: CLI serve structure cleanup](decisions/0008-cli-serve-structure-cleanup-follow-up.md)
- [`vite-plugin.ts`](../packages/cli/src/serve/vite-plugin.ts)
- [`serve.ts`](../packages/cli/src/cli/serve.ts)
- [`server.ts`](../packages/cli/src/serve/server.ts)
- [Vite 6 Plugin API](https://v6.vite.dev/guide/api-plugin)
- [Vite 6 JavaScript API](https://v6.vite.dev/guide/api-javascript)
- [Vite 5.4.21 dev-server source](https://github.com/vitejs/vite/blob/v5.4.21/packages/vite/src/node/server/index.ts)
- [Vite 5.4.21 plugin types/source](https://github.com/vitejs/vite/blob/v5.4.21/packages/vite/src/node/plugin.ts)
