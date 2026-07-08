# The Adoption Experience: Mirror and Disappear

Status: draft, agreed direction (2026-07-08). Governs the server-side
adoption story; companion to `remote-sandbox.md`.

## The thesis

Pyric mirrors Firebase and disappears in prod. Therefore **pyric
identifiers in application code are a defect** — the `connectFirestoreEmulator()`
trap. App code imports Firebase names; the *environment* decides what they
resolve to. There is one substitution seam per runtime:

| Runtime | Seam | Status |
|---|---|---|
| Browser, unbundled | `pyric serve` injected import map (`firebase/app` → `/__pyric/sdk/app.js`) | shipped |
| Browser, bundled | Vite plugin aliasing | shipped |
| Node (server) | module-customization hooks (`--import pyric-tools/register`) mapping `firebase-admin/*` → `pyric-admin/*`, `firebase/*` → `pyric/*` | to build |

## Activator vs locator (decided)

- **Activator**: an env signal (`PYRIC_SANDBOX=remote[:url]`) injected by
  pyric tooling at invocation — never file presence, never app code.
  The loader is inert without it; refuses under `NODE_ENV=production`
  unless forced; logs one line on activation.
- **Locator**: `.pyric/serve.json` discovery with health + instanceId
  pinning (the existing mcp-proxy/connectRemoteSandbox protocol).

Rationale: file-presence activation is ambient mode-by-side-effect
(cwd-dependent, stale-file-prone, silent in both failure directions) —
the Node twin of the outlawed M2 pattern. The invocation is the point of
use; that's where the explicit parameter lives (the user's `dev` script).

## One command, not two (decided)

`serve` vs `dev` would split along frontend vs backend — incoherent for
fullstack users, since `serve` already IS the dev command for frontends
(it hosts the user's app with import-map substitution). One behavior,
"stand up my dev world," with an optional child process = one command:

- `pyric dev` — host + frontend + Studio/bridge; runs the package.json
  `dev` script if present (env + loader injected, output prefixed), else
  host-only; opens and monitors the sandbox tab.
- `pyric dev -- <cmd>` — explicit child override.
- `pyric dev --no-run --no-open` — exactly today's serve (composition
  path for own-process-manager users).
- `pyric dev --json` — machine mode for agents (today's `serve --json`).

All current serve flags (`--persist`, `--seed`, `--fresh`, `--capture`)
carry over — they belong to the host, which is unchanged. `serve` becomes
a hidden alias through alpha, then retires; `.pyric/serve.json` keeps its
name (it describes the host); pyric-plugin skill + agent docs migrate to
`dev` immediately (they're ours). Getting-started only ever says
`pyric dev`.

## The layer model

Defaults on top, composability all the way down; every layer is sugar over
the one below, nothing reachable only through magic:

1. `pyric dev` — the single front door (above).
2. `pyric-tools/register` — the hooks alone, for users with their own
   process manager.
3. Ambient init — bare `initializeApp()` + env → lazy remote handle (for
   manifest-alias users: `"firebase-admin": "npm:pyric-admin"`).
4. `initializeApp({ sandbox })` + `connectRemoteSandbox()` — explicit
   composition for tests/tools (legitimately pyric-aware code).
5. Raw `RemoteSandboxChannel` — transport internals.

## Target experience

```bash
npm i -D pyric-tools pyric-admin pyric
pyric dev
```

Zero app-code changes. Prod = not running under pyric; nothing to revert.

## Work items (post slice-1, alpha window)

1. Default-app registry in pyric-admin (mirror conformance: bare
   `initializeApp()`, no-arg `getDatabase()`/`getAuth()`, firebase-admin
   duplicate-app error shapes) — S.
2. Ambient init (env resolution in bare `initializeApp()`, lazy handle,
   activation log, prod guard) — S, on checkpoint-2 machinery.
3. `pyric-tools/register` module hooks — M. Edge: CJS `require()`
   interception needs `module.registerHooks` (Node 22.15+) or
   require-patching; ESM is clean via `module.register`. **Ask the first
   user: ESM or CJS?** — decides whether this edge is first or later.
4. `pyric dev` runner — M. Becomes the single front door and the single
   activation concept for both env and loader.
5. Adoption docs collapse to the two commands above.

Sequence 1→2 first (completes the first user's ambient story with a
manifest alias), then 3→4 (the full disappearing act). None of it gates
the slice-1 publish.
