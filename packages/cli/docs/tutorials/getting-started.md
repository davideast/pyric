# Getting started — scaffold a Vite app, run it, and let an agent drive

By the end of this tutorial you will have:

- A scaffolded Firebase-shaped Vite app (canonical `firebase/*` imports).
- `vite dev` running it against an **in-browser sandbox** via `@pyric/cli/vite` —
  your `firestore.rules` hot-reloaded, no emulator suite, no Java, no Firebase
  project.
- Claude Code connected through the **pyric plugin**, with the agent
  reading and writing your sandbox.

Takes about five minutes. You do not need a Firebase account.

## Prerequisites

- Node 22+ and `npm` (or `bun` — commands are equivalent).
- For step 4: Claude Code installed (`claude --version` works).

## Step 1 — Scaffold an app

```bash
npm create pyric hello-pyric
cd hello-pyric
npm install
```

(`npx create-pyric hello-pyric` is the same. Or install `@pyric/cli` and run
`pyric init`.)

The scaffold is a Vite app with **canonical Firebase imports**
(`firebase/app`, `firebase/auth`, `firebase/firestore` — no pyric imports
in app code), a `firestore.rules` file, a `firebase.json`, and
`@pyric/cli` as a devDependency wired through `vite.config.ts`.

## Step 2 — Run it on the sandbox

```bash
npm run dev
```

That is `vite dev` with the `@pyric/cli/vite` plugin. Open the URL Vite
prints. You'll see the scaffold app. Everything you're looking at is running
against an **in-page Firestore sandbox**: the plugin swaps unmodified
`firebase/*` imports to pyric's adapters and hot-reloads `firestore.rules`.

Prove it to yourself:

1. Sign in anonymously and create a post in the UI — it appears.
2. Edit `firestore.rules` and change the posts rule to `allow read: if
   false;`, save — rules hot-reload and the post list now shows a permission
   error. Put it back.

That loop — edit rules, watch real enforcement instantly — is the core
of what pyric adds. No deploy, no emulator boot.

(Prefer a no-bundler path? `pyric init --template static` then `pyric dev`.)

## Step 3 — Persistence and multi-tab

On a modern browser the sandbox runs in a **SharedWorker**: every tab shares
one backend, and data survives a refresh by default. With the Vite plugin,
pass options in `vite.config.ts`:

```ts
pyricSandbox({ persist: true, seed: 'seed.json' })
```

Full details — ephemeral runs, clearing data, SharedWorker gotchas — are in
[persistence and multi-tab](../how-to/serve-persistence-and-multi-tab.md) and
[use the Vite plugin](../how-to/use-the-vite-plugin.md).

## Step 4 — Connect Claude Code (the plugin)

Install the pyric plugin:

```bash
claude plugin install https://github.com/davideast/pyric
# (plugin path: pyric-plugin/) — or for a local checkout:
claude --plugin-dir ./pyric-plugin
```

Then, in Claude Code inside your app's directory, run:

```
/pyric:pyric-start
```

The skill starts `pyric dev --bridge --persist` and opens the app.
`--bridge` exposes an MCP endpoint inside the dev server; the plugin's stdio
proxy (`pyric mcp-proxy`) finds the running dev server automatically via the
`.pyric/serve.json` pointer — **no `claude mcp add`, no port wiring**.

## Step 5 — Let the agent drive

Ask Claude Code:

> Add a `comments` collection with a couple of sample documents, then
> tighten my rules so only a comment's author can delete it.

Watch the page: documents appear as the agent writes them through the
bridge into the *same sandbox* you're looking at, and the rules
edit deploys live. You can inspect what it did with:

```bash
pyric snapshot            # dump sandbox state to a file
```

## You now have

A local Firebase-shaped dev loop where the backend lives in your browser
tab, rules are enforced for real, and an agent can safely operate on all
of it — and the same app code deploys unchanged against real Firebase
(`firebase deploy` via `firebase-tools` / Console).

## Where next

- **Every command + flag:** the [CLI reference](../reference/cli.md), and the
  full [docs index](../README.md) (guides for verify, snapshot,
  persistence/multi-tab, Vite plugin).
- **Existing Firebase app instead of a scaffold?** `pyric dev` works in
  any directory with a `firebase.json` — start at Step 2 in your app.
- **Manual MCP wiring (no plugin), or connecting a sandbox embedded in
  your own dev server:** [wire-claude-code.md](./wire-claude-code.md).
- **Deploying for real** (rules, indexes, hosting incl. preview
  channels, functions): [`../deploy/`](../deploy/README.md), and
  [`deploy-to-a-preview-channel`](../deploy/how-to/deploy-to-a-preview-channel.md).
- **Agent-facing CLI I/O** (`--schema` / `--json` on deploy commands):
  [`../deploy/reference/cli-agent-io.md`](../deploy/reference/cli-agent-io.md).
- **Why an in-browser sandbox at all:** the explanation docs under
  [`packages/pyric/docs/sandbox/`](../../../pyric/docs/sandbox/).
