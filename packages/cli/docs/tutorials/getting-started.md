# Getting started — scaffold, run pyric dev, and let an agent drive

By the end of this tutorial you will have:

- A scaffolded Firebase-shaped web app (canonical `firebase/*` imports).
- `pyric dev` running it against an **in-browser sandbox** — your
  `firestore.rules` deployed into the page, no emulator suite, no Java,
  no Firebase project.
- Claude Code connected through the **pyric plugin**, with the agent
  reading and writing your sandbox.

Takes about five minutes. You do not need a Firebase account.

## Prerequisites

- Node 22+ and `npm` (or `bun` — commands are equivalent).
- For step 4: Claude Code installed (`claude --version` works).

## Step 1 — Scaffold an app

Install the CLI globally, then scaffold:

```bash
npm i -g @pyric/cli            # installs the `pyric` command
mkdir hello-pyric && cd hello-pyric
pyric init --template web
```

(No global install? `npx @pyric/cli init --template web` works the same way,
package by package.)

`init` writes a small app with **canonical Firebase imports**
(`firebase/app`, `firebase/auth`, `firebase/firestore` — no pyric imports
in app code), a `firestore.rules` file, a `firebase.json`, a seed file,
and adds `@pyric/cli` as a devDependency. Then install the app's deps:

```bash
npm install
```

## Step 2 — Serve it on the sandbox

```bash
pyric dev
```

Open <http://localhost:3473>. You'll see the scaffold app with two seeded
posts ("Welcome to pyric"). Everything you're looking at is running
against an **in-page Firestore sandbox**: `pyric dev` serves an import
map that resolves the app's unmodified `firebase/*` imports to pyric's
adapters, and deploys `firestore.rules` into the sandbox at page load.

Prove it to yourself:

1. Sign in anonymously and create a post in the UI — it appears.
2. Edit `firestore.rules` and change the posts rule to `allow read: if
   false;`, save — pyric dev hot-reloads the rules and the post list now
   shows a permission error. Put it back.

That loop — edit rules, watch real enforcement instantly — is the core
of what pyric adds. No deploy, no emulator boot.

## Step 3 — Your data, across reloads and tabs

On a modern browser `pyric dev` runs the sandbox in a **SharedWorker**: every
tab shares one backend (writes sync live across tabs), and the data is kept in
the browser — so it **survives a refresh by default**. Add `--persist` for a
committable, git-trackable copy on disk:

```bash
pyric dev --persist       # also writes .pyric/state/state.json
```

`--fresh` discards the on-disk state; `--seed <file>` loads a fixture set on
boot (the scaffold ships one). Full details — running ephemerally, clearing
data, and SharedWorker gotchas — are in
[persistence and multi-tab](../how-to/serve-persistence-and-multi-tab.md).

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
with production artifacts deployed by the Firebase CLI.

## Where next

- **Every command + flag:** the [CLI reference](../reference/cli.md), and the
  full [docs index](../README.md) (guides for verify, snapshot,
  persistence/multi-tab, the bridge, and the Vite plugin).
- **Existing Firebase app instead of a scaffold?** `pyric dev` works in
  any directory with a `firebase.json` — start at Step 2 in your app.
- **Manual MCP wiring (no plugin), or connecting a sandbox embedded in
  your own dev server:** [wire-claude-code.md](./wire-claude-code.md).
- **Deploying for real:** use the Firebase CLI for rules, indexes, hosting,
  functions, and preview channels.
- **Why an in-browser sandbox at all:** the explanation docs under
  [`packages/pyric/docs/sandbox/`](../../../pyric/docs/sandbox/).
