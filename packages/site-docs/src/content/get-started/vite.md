---
title: "Vite development setup"
navLabel: "Vite"
group: "Get started"
section: ""
order: 20
description: "Configure Vite module aliasing and dev server integration for Pyric."
---

# Vite development setup

The Pyric Vite plugin runs pyric inside Vite's single development server.

## Add the plugin to your configuration

Install `@pyric/cli` as a development dependency and add the `pyric` plugin to `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyric()],
});
```

The plugin attaches directly to Vite's Connect middleware stack and import map resolution. All requests to `/__pyric/*` and imports of `firebase/*` execute directly on a Vite development server port (default 5173).

## Start your local server

Run your normal Vite development server:

```bash
npm run dev
```

Vite serves the application and Pyric Studio simultaneously on the exact same local origin. Access Studio at `/__pyric/ui/studio` or by clicking the floating runtime chip in the bottom-right corner of the browser.

## Share a Node-hosted sandbox across browsers

The default `pyric()` runs the sandbox in a SharedWorker. To share one sandbox
across different browsers, devices, Studio and agent clients, opt into the Node
host in your Vite configuration:

```ts
export default defineConfig({
  plugins: [pyric({ hosted: true })],
});
```

Run the same `npm run dev` command using Node 22.15 or later. The sandbox runs
inside the Vite server process; no second server is needed. The bridge mounts
automatically, and Studio uses the same backend at `/__pyric/ui/studio`.

Hosted state is durable in `.pyric/state/hosted/state.sqlite`, including when
`persist` is omitted or false. Use `fresh: true` to archive that hosted directory
and reapply the seed on each server start; remove it after the reset. Only one server can own a project's
persisted state at a time. Stop it before starting another host for that project.

Hosted persistence currently requires the Node runtime. The Bun standalone CLI
and running Vite under Bun do not support hosted mode yet. SharedWorker mode
keeps its existing browser storage; switching modes does not transfer data.
See [hosted persistence and recovery](../build/hosted-persistence.md) for limits,
snapshots and recovery commands.

Saving Firestore or Realtime Database rules updates the running host. Normal
Vite HMR remains available. Hosted mode requires Vite's own HTTP server and
rejects `server.middlewareMode`; `vite preview` does not start a Node sandbox.
A production `vite build` continues to use Firebase. To return to the default
SharedWorker sandbox, remove `hosted` or set it to `false`.

## Specify custom Security Rules

Pass explicit rules paths to the plugin options when your rules files live outside standard discovery paths:

```ts
export default defineConfig({
  plugins: [
    pyric({
      rules: 'security/firestore.rules',
    }),
  ],
});
```

The plugin hot-reloads Security Rules whenever the file is saved. If omitted, Pyric checks `firestore.modules.rules`, `firebase.json`, and `firestore.rules` automatically.

## Give provider sign-ins a default photo

With no configuration, a provider sign-in such as Google or GitHub gets a deterministic generated avatar, matching Firebase's own guarantee that a federated identity always carries a `photoURL`. Configure the `avatars` option to serve your own images instead:

```ts
export default defineConfig({
  plugins: [
    pyric({
      avatars: './avatars/anime',
    }),
  ],
});
```

A string names a pre-built avatar set directory; an object with a `source` function generates images in the dev server; `false` turns avatars off entirely. See [Assign default avatars to sandbox users](../build/default-avatars.md) for the set format, the source callback, and the `PYRIC_AVATARS` environment variable `pyric sandbox` reads instead.
