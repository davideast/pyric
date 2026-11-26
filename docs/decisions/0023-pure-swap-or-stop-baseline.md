# 0023: Pure swap-or-stop baseline and removal of runtime socket/network interception

Status: Accepted

Date: 2026-11-09

Supersedes in part: [ADR 0022](./0022-swap-or-stop.md) (retires the credential-choke-point network guard and live socket host reporter while keeping and tightening module-resolution swap-or-stop).

## Context

[ADR 0022](./0022-swap-or-stop.md) established that module-resolution swap-or-stop is the architectural safety guarantee: every recognized `firebase` and `firebase-admin` import swaps to Pyric's sandbox mirrors (or `@pyric/live`'s observed SDK rows), and every unrecognized import into a real Firebase SDK package stops at module resolution (`PYRIC_REAL_SDK_STOPPED`) before the module loads.

Alongside module swap-or-stop, ADR 0022 retained two runtime network-layer hooks:

1. **The sandbox token-endpoint guard** (`packages/cli/src/register/net-guard.ts` and `packages/cli/src/serve/vite-net-guard.ts`), which monkey-patched `net.Socket.prototype.connect`, `tls.connect`, `http.request`, `https.request`, `dns.lookup`, and Undici diagnostics channels to block Google OAuth / metadata token endpoints (`PYRIC_GUARD_BLOCKED`).
2. **The live socket host reporter** (`packages/cli/src/register/live-net-guard.ts`), which hooked outbound Node HTTP/TLS/Undici requests in `@pyric/live` processes to print `unobserved call to <host>` lines and populate `unobserved` host lists.

While Pyric is in alpha, maintaining global socket, DNS, TLS, and HTTP prototype interception creates recurring fragility across APM tools (`shimmer`, OpenTelemetry, `require-in-the-middle`), custom `http.Agent` subclasses, and Undici internals, while offering only a best-effort backstop when module resolution was never installed in the first place. Meanwhile, three baseline runtime entry points still warned and continued instead of stopping when Pyric could not install synchronous module swap-or-stop:

- `pyric sandbox -- bun ...` / `bunx ...` / `deno ...` printed a warning (`Warning only: nothing was blocked`) and spawned the child runtime with unswapped `firebase` and `firebase-admin` imports reaching live Firebase.
- `@pyric/cli/register` on Node `< 22.15` (where synchronous `module.registerHooks` is absent) fell back to asynchronous `module.register`, leaving CommonJS `require('firebase-admin')` unswapped, and `installViteProcessStop` silently returned `false`.
- `withPyric()` in Next.js development mode only logged a warning when Edge runtime routes or middleware were present, even though the Next.js Edge runtime has no Node `module.registerHooks` loader.

## Decision

### 1. Swap or stop at module and startup boundaries; no socket or network guard

Pyric drops all runtime socket, DNS, TLS, HTTP, and Undici interception in both sandbox mode and live mode:

- Remove `packages/cli/src/register/net-guard.ts`, `packages/cli/src/register/live-net-guard.ts`, `packages/cli/src/register/connect-prototypes.ts`, `packages/cli/src/serve/vite-net-guard.ts`, and `packages/cli/src/google-token-endpoints.ts`.
- Keep `packages/cli/src/google-endpoints.ts` for static build-artifact scanning (`inlined-sdk-scanner.ts`).
- Keep all module-resolution swap-or-stop mechanisms (`@pyric/cli/register` `withSwapOrStop`, `worker-guard.ts`, `child-process-guard.ts`, Vite client/SSR module swap and `installViteProcessStop`, Next.js `withPyric` client aliases and `serverExternalPackages`, and `@pyric/live` SDK-level project/import refusals in `packages/live/src/{refusal,start-checks}.ts`).
- Remove socket-derived `unobserved` host lists (`LiveHostStatus.unobserved`, `ProcessHealth.unobserved`, `NodeUnobservedLists.unobserved`, and `LiveHostStateInput.unobserved`) alongside `live-net-guard.ts`, while preserving module-level live coverage reporting (`unobservedAdmin`, `gatedAdmin`, and `passThrough`) on `/__pyric/health` and live client health reports.

### 2. Deprecated `PYRIC_GUARD` and `PYRIC_GUARD_ALLOW` compatibility

Existing scripts and CI configurations that still set `PYRIC_GUARD` or `PYRIC_GUARD_ALLOW` must not crash:

- When `PYRIC_GUARD` or `PYRIC_GUARD_ALLOW` is non-empty in the environment at CLI sandbox/run startup, `@pyric/cli/register` activation, or standalone `pyric()` Vite plugin startup (`createPyricPlugin`'s `config` hook), `warnDeprecatedGuardEnvOnce` writes a single deprecation notice to `stderr` explaining that runtime socket interception has been removed in favor of module-level swap-or-stop, and takes no other action.
- The handshake beacon (`/__pyric/beacon`) and `pyric sandbox` interlock report `{ pid, hooks, sandbox }` without a `guard` mode field.

### 3. Stop upfront on unswappable baseline runtimes

Where Pyric cannot guarantee synchronous module swap-or-stop on a baseline surface, it refuses to start with a coded, actionable error instead of warning and running unswapped code:

1. **Unsupported child runtime in `pyric sandbox` and `pyric run` (`PYRIC_UNSUPPORTED_RUNTIME`):** When `detectUnsupportedRuntime(argv)` identifies `bun`, `bunx`, or `deno` (including across shell operators, subshells, `env`, `npx`, `pnpm dlx`/`exec`, `yarn dlx`/`exec`, and `sh`/`bash`/`zsh` `-c`), `pyric sandbox` and `pyric run` refuse to spawn the child command and exit non-zero (`1`), naming `node` and `npx tsx` as supported alternatives.
2. **Node `< 22.15` without `module.registerHooks` (`PYRIC_UNSUPPORTED_NODE_VERSION`) and standalone Vite under Bun (`PYRIC_UNSUPPORTED_RUNTIME`):** `@pyric/cli` requires `node >= 22.15`. When `module.registerHooks` is unavailable on Node in `@pyric/cli/register` or in `installViteProcessStop`, Pyric throws `PYRIC_UNSUPPORTED_NODE_VERSION` immediately instead of falling back to asynchronous `module.register` (`packages/cli/src/register/hooks.ts` is removed). When standalone Vite (`command === 'serve'`) runs under Bun (`bunx --bun vite dev`), `installViteProcessStop` throws `PYRIC_UNSUPPORTED_RUNTIME` naming Bun and `npx vite dev` (exempting only in-process `bun test` unit runners).
3. **Next.js Edge runtime in `withPyric` (`PYRIC_EDGE_RUNTIME_UNSUPPORTED`):** During sandbox development (`!isProductionPassthrough(phase)`), `findEdgeRuntimeFiles(process.cwd())` strips comments and flags App Router or Pages Router files declaring `export const runtime = 'edge' | 'experimental-edge'` or `export const config = { runtime: 'edge' | 'experimental-edge' }`, as well as `middleware` / `src/middleware` files without a Node opt-in (`export const runtime = 'nodejs'` or `export const config = { runtime: 'nodejs' }`). Next.js 16 `proxy` / `src/proxy` files run on Node by default and are flagged only if they explicitly declare an Edge runtime. When Edge files are present, `withPyric` throws `PYRIC_EDGE_RUNTIME_UNSUPPORTED` naming each file and instructing the developer to switch to `export const runtime = 'nodejs'` (or set `PYRIC_ALLOW_UNSWAPPED_EDGE=1` to downgrade to a warning when an Edge file intentionally never imports Firebase).

## Consequences

- **Simpler, deterministic safety boundary:** Safety rests entirely on module resolution (`swap-or-stop`), worker/child preload propagation, static bundle scanning, and `@pyric/live` SDK-level project gates -- with zero monkey-patching of Node's networking stack.
- **No silent unswapped execution on baseline surfaces:** Invoking `pyric sandbox` with `bun`/`deno`, running `@pyric/cli/register` or Vite on Node `< 22.15`, or running `withPyric` with Next.js Edge routes fails fast before application code can contact a live project such as `users/$uid` or `items/{id}`.
- **Outbound non-Firebase HTTP is unimpeded:** Application code calling third-party APIs, local model servers, or custom telemetry endpoints never contends with socket or Undici hooks. Direct REST/`fetch` calls to Google endpoints that bypass the Firebase SDK are outside Pyric's module boundary by design.
