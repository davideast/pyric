---
title: Your backend in one command
navLabel: Start building
outcome: Run a working Firebase backend locally, in a new app or the one you already have.
status: draft
---

# Your backend in one command

```bash
npm i -g pyric-tools
npx pyric dev
```

That is a full Firebase backend, running inside the browser tab you are about to open. No account. No cloud project. No emulator, no Java, no port to babysit. `pyric dev` works in any directory with a `firebase.json`: it serves your app and resolves its ordinary `firebase/*` imports to a local sandbox, with your `firestore.rules` enforced from the first request.

No app yet? Scaffold one.

## Scaffold a new app

```bash
mkdir hello-pyric && cd hello-pyric
npx pyric init --template web
npm install
npx pyric dev
```

Open <http://localhost:3473>. The scaffold is a small posts app with canonical `firebase/app`, `firebase/auth`, and `firebase/firestore` imports, owner-based rules, and a seed file with two posts already in it. Sign in and create a post. It appears.

Now prove the rules are real. Open `firestore.rules`, change the posts rule to `allow read: if false;`, and save. The rules hot-reload and the post list becomes a permission error. Put the rule back and the posts return. That loop, edit rules and watch real enforcement respond, is the loop everything else builds on.

Building a script or a test suite instead of a page? `npx pyric init --template node` scaffolds the Node shape.

## Add Pyric to an app you already have

Pick by how your app is built.

**You build with Vite.** Add one plugin and keep your own dev loop, HMR and all:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricSandbox } from 'pyric-tools/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```

`vite dev` now swaps `firebase/app`, `firebase/auth`, and `firebase/firestore` to the sandbox at module resolution, deploys your `firestore.rules` at page load, and hot-reloads them on save. A plain `vite build` still ships the real `firebase` package. Nothing in your source changes.

**Your app is static or already built.** Run `pyric dev` in the directory. It serves the files and injects an import map that resolves the page's bare `firebase/*` imports to the sandbox at load time. Same swap, different layer. It can run your own dev command too: `pyric dev -- npm run dev`.

## Your data survives

The sandbox runs in a SharedWorker, so every tab shares one backend and a write in one tab shows up live in the others. The data lives in IndexedDB and survives a refresh. Add `--persist` for a committable on-disk copy at `.pyric/state/state.json`, `--seed <file>` to load a fixture on boot, or `--fresh` to start over.

## And from an agent

One flag gives your agent the same backend:

```bash
npx pyric dev --bridge
```

`--bridge` mounts an MCP endpoint on the dev server, and any MCP client (Claude Code, Cursor, Codex) can seed data, run queries, and check rules verdicts against the exact sandbox your tabs are using. [Set up your agent](../agent/set-up-your-agent.md) walks through each client.

## Where to go next

You have a backend. [What just happened](./what-just-happened.md) explains the swap in one page, or go straight to [signing users in](../build/sign-in-and-manage-users.md).
