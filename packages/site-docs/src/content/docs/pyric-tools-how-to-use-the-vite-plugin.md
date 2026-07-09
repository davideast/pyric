---
title: "Use the Vite plugin (pyric-tools/vite)"
navLabel: "Use the Vite plugin"
group: "pyric-tools"
section: "How-to"
order: 10
---
# Use the Vite plugin (`pyric-tools/vite`)

The `pyricSandbox()` Vite plugin gives a **source-driven** app the same
`firebase/*` → pyric-sandbox swap that `pyric dev` gives a **static** app —
without leaving your normal `vite dev` loop (HMR, source maps, your own
router/UI stack). Your app's `firebase/*` imports stay exactly as written; the
plugin swaps them at Vite's module-resolution layer, in dev only.

## Plugin or `pyric dev`? (they're complementary)

Both do the identical thing — run your unmodified `firebase/*` against an
in-browser pyric sandbox with your `firestore.rules` enforced — but at different
points in your toolchain. Pick by how your app is built:

| | `pyricSandbox()` Vite plugin | `pyric dev` |
|---|---|---|
| **Use it for** | source-driven apps you run with `vite dev` | static / pre-built / retrofit apps (`dist/`, `public/`, any folder with `firebase.json`) |
| **Where the swap happens** | at module resolution, before bundling | at load time, via a runtime import map over already-built files |
| **Dev loop** | your existing `vite dev` (HMR, source maps) | `pyric dev` owns the dev server |

They are **not** competing. If you already build with Vite, the plugin keeps you
in one toolchain (`vite dev` for the sandbox, `vite build` for prod). If you have
a pre-built or no-build app, reach for [`pyric dev`](../pyric-tools-how-to-serve-persistence-and-multi-tab/).

> **What the plugin covers.** It swaps `firebase/*`, deploys/hot-reloads your
> rules, runs the sandbox in a **SharedWorker** (one backend shared across tabs,
> durable in IndexedDB), supports opt-in on-disk **persistence**, **seeding**, and
> session **capture**, and can mount the **MCP bridge** (`bridge: true`) so an
> external agent drives the same sandbox — the same surface `pyric dev` gives a
> static app, in one Vite plugin.

## Prerequisites

- A Vite app (Vite 5, 6, or 7) whose data layer uses canonical `firebase/*`
  imports (`firebase/app`, `firebase/auth`, `firebase/firestore`).
- A `firestore.rules` file (and optionally a `firebase.json`) in your project.

## Install

Add `pyric-tools` as a dev dependency:
```bash
npm install --save-dev pyric-tools
```
(`vite` is a peer dependency you already have.)

## Add it to `vite.config.ts`

Import `pyricSandbox` from `pyric-tools/vite` and add it to your `plugins`:
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricSandbox } from 'pyric-tools/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```
With no options, the plugin discovers your rules from `firebase.json`'s
`firestore.rules`, falling back to `firestore.rules` in your project root.

### Options

`pyricSandbox(options?)` — all optional:

| Option | Type | Default | What it does |
|---|---|---|---|
| `rules` | `string` | `firebase.json`'s `firestore.rules`, else `firestore.rules` in the project root | Path to your Firestore rules file, **relative to `root`**. Overrides whatever `firebase.json` declares. |
| `root` | `string` | Vite's own `root` | Project directory used to discover `firebase.json` and resolve `rules`. |
| `persist` | `boolean` | `false` | Persist sandbox data + test users to `.pyric/state/state.json` so they survive reloads and restarts. Off = ephemeral. |
| `fresh` | `boolean` | `false` | With `persist`: discard the existing state file and re-seed from scratch. |
| `seed` | `string` | — | Path to a seed file: a `"collection/doc" → fields` JSON map, **or** a `pyric snapshot` state-file. Applied at page init; lived state wins once it exists. |
| `capture` | `boolean` | `true` | Write the live session to `.pyric/last-session.json` for `pyric verify`. Pass `false` to suppress. |
| `bridge` | `boolean \| { project?, disableAuditLog? }` | `false` | Mount the **MCP bridge** so an external agent can drive the sandbox. `true` ⇒ defaults; the object form sets the audit project / disables the audit log. The agent shares the **same SharedWorker sandbox** as your app (and Studio) — see [Drive the sandbox from an agent](#drive-the-sandbox-from-an-agent-bridge). |
```ts
// Point at a non-default rules file, and persist + seed the sandbox
pyricSandbox({
  rules: 'config/firestore.rules',
  persist: true,
  seed: 'seed.json',
});
```
## Run your app on the sandbox

Start your normal dev server:
```bash
npm run dev   # i.e. vite dev
```
Now `vite dev` serves your app against the in-process pyric sandbox:

- Your app's `firebase/*` imports are **unchanged** — the plugin swaps
  `firebase/app`, `firebase/auth`, and `firebase/firestore` to pyric's adapters
  at resolution time. You never import anything from pyric in app code.
- Your `firestore.rules` are **deployed at page load**: the plugin injects a
  small init module into the served HTML, and that module deploys your rules
  before your app code runs.
- The Firebase config you pass to `initializeApp(config)` is
  **accepted but ignored** in dev. No project, no credentials, no network —
  the sandbox stands in for the real backend. (That same config flows through
  untouched to your production build; see [Production](#production-vite-build).)

### Rules hot-reload on save

Edit your `firestore.rules` and save. The plugin watches the file (through
Vite's own watcher — no second file watcher) and **re-deploys the rules in
place**, with no page reload. You'll see a line like:
```
  ↻ [pyric] rules reloaded (a1b2c3d4e5f6)
```
If a save leaves the rules un-parseable, the plugin keeps the **last good**
ruleset live and warns instead of breaking your session:
```
  ⚠ [pyric] rules NOT reloaded (last-good stays live): <reason>
```
Fix the file and save again to deploy the corrected rules.

### Multi-tab sync and persistence

By default the sandbox runs in a **SharedWorker**: every tab of your dev origin
talks to **one** backend, so a write in one tab shows up live in another, and the
data is held in IndexedDB (it survives a refresh). If the browser lacks
`SharedWorker`, the plugin falls back to a per-tab in-page sandbox automatically.

That IndexedDB data is still **browser-local** — it doesn't land in your repo. To
make data + test users durable across restarts (and committable), turn on
`persist`:
```ts
pyricSandbox({ persist: true });          // writes .pyric/state/state.json
pyricSandbox({ persist: true, fresh: true }); // wipe + re-seed this run
```
To preload data, point `seed` at a `"collection/doc" → fields` map or a file from
`pyric snapshot`. With `persist`, the seed applies only on the first run — after
that, **lived state wins**:
```ts
pyricSandbox({ seed: 'seed.json' });
```
The persistence model — the `.pyric/state` file, `persist` vs `fresh`, and how
seed precedence works — is identical to `pyric dev` and documented in depth in
[Persistence and multi-tab](../pyric-tools-how-to-serve-persistence-and-multi-tab/).

## Drive the sandbox from an agent (`bridge`)

Turn on `bridge` and the plugin mounts the **MCP bridge** on Vite's own dev
origin — so an external agent (Claude Code, Cursor, any MCP client) can read and
write the *same* sandbox your app is using, live, while you keep `vite dev`:
```ts
pyricSandbox({ bridge: true });
// or tune the audit log:
pyricSandbox({ bridge: { project: 'my-app', disableAuditLog: false } });
```
This adds three routes on your dev server's port (no sidecar process):

| Route | What it is |
|---|---|
| `POST /__pyric/mcp` | MCP over streamable HTTP — point your agent here |
| `GET /__pyric/health` | bridge health JSON |
| `WS /__pyric/sandbox` | the page's bridge peer, routing to the SharedWorker (wired automatically) |

Connect from Claude Code with the **pyric Claude Code plugin** — it runs a bundled
stdio proxy that auto-discovers the running bridge from `.pyric/serve.json` (no
fixed port, no `claude mcp add`). The [Wire Claude Code](../pyric-tools-tutorials-wire-claude-code/)
tutorial walks the agent-side setup end to end.

Open your app in a browser tab; the page connects to the bridge automatically (the
plugin injects the bridge URL into the served init payload), and your agent can
then seed, query, undo/redo, and audit the sandbox the page is running on.

> **One shared sandbox.** The bridge routes the agent's tool-calls *through* the
> **SharedWorker** — the same backend your app and (if enabled) Pyric Studio use.
> Agent writes show up live in your open tab and in Studio, and vice versa; there
> is no separate agent sandbox. The agent still reaches the worker through an open
> page, so keep a tab open while it works.

The bridge is the same machinery as [`pyric dev --bridge`](../pyric-tools-how-to-serve-persistence-and-multi-tab/);
the [Wire Claude Code](../pyric-tools-tutorials-wire-claude-code/) tutorial walks the
agent-side setup end to end.

## Production (`vite build`)

The plugin is **dev-only** (`apply: 'serve'`). A production `vite build` ships
the **real `firebase` package** — the swap never reaches your production output.

This means there is **no separate "graduation" step**. The Firebase config you
passed to `initializeApp` — ignored by the sandbox in dev — is the *same* config
your built app uses to talk to real Firebase in production. Dev and prod are one
toolchain: `vite dev` runs on the sandbox, `vite build` runs on Firebase, and
your source never changes between them.

## Library imports are swapped too (transitive deps)

The swap happens at resolution time, *before* bundling, so it also catches
libraries that import `firebase/*` on your behalf — `react-firebase-hooks`,
`reactfire`, and similar. When such a library does
`import { getFirestore } from 'firebase/firestore'`, that import resolves to the
sandbox adapter exactly as your own code does. The library transparently runs on
the sandbox with no changes.

This works because the plugin also tames Vite's **dependency optimizer**. Vite
pre-bundles `node_modules` with esbuild; left alone, the optimizer would pre-bake
a library's `firebase/*` import to the *real* firebase before the plugin's
resolver ever runs. The plugin mirrors its swap into the optimizer's esbuild pass
(and excludes the served `firebase/*` modules from pre-bundling) so the optimizer
and the dev resolver agree. You don't configure any of this — adding the plugin
is enough — but it's why the swap reaches dependencies, not just your own code.

## Limitations

What the plugin does and doesn't cover:

- **Libraries that reach into Firebase internals throw at import.** The swap
  mirrors Firebase's **public modular surface** — what your app and most
  data-layer libraries use. A library that reaches into Firebase *internals* —
  `@firebase/component`, `_getProvider`, app component registration (e.g.
  `firebaseui`, parts of `@angular/fire`) — falls outside that surface and
  **throws at import**. This is inherent to mirroring the public API; `pyric
  serve` has the same ceiling.

- **Only `firebase/app`, `firebase/auth`, and `firebase/firestore` are swapped.**
  Other subpaths (`firebase/storage`, `firebase/database`) resolve to the real
  package — the same surface `pyric dev` covers today.

- **The agent reaches the sandbox through an open page.** `pyricSandbox({ bridge: true })`
  routes the agent's tool-calls through the SharedWorker — the same backend your
  app and Studio use — but the worker lives in the browser, so a tab must stay
  open for the agent to act. (`pyric dev --bridge` has the same shape.)

## Troubleshooting

**`pyric-tools/vite: pyric is not built …`** — the plugin needs pyric's compiled
output to read Firebase's public surface. In a monorepo checkout, build pyric
first (e.g. `bun run build`). An installed `pyric-tools` from npm ships built, so
you'll only hit this developing against a source checkout.

**A `firebase/*` import you expected to swap didn't.** Only `firebase/app`,
`firebase/auth`, and `firebase/firestore` are swapped. Other `firebase/*`
subpaths (e.g. `firebase/storage`, `firebase/database`) resolve to the real
package in this release.

## See also

- [Persistence and multi-tab with `pyric dev`](../pyric-tools-how-to-serve-persistence-and-multi-tab/)
  — the static-app analog; the worker/persist/seed model is identical to the plugin's.
- [Getting started](../pyric-tools-tutorials-getting-started/) — the end-to-end scaffold →
  serve → agent loop.
- [Why an in-browser backend is *not* Firestore offline persistence](../pyric-sandbox-explanation-local-backend-vs-firestore-offline/).
