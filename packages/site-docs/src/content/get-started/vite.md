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

The plugin attaches directly to Vite's Connect middleware stack and import map resolution. All requests to `/__pyric/*` and the browser's imports of `firebase/*` execute directly on a Vite development server port (default 5173).

## Server-rendered code

Under `vite dev`, server-rendered modules get the swap too ([how the swap works](./how-the-swap-works.md#server-rendered-modules)). With `pyric({ hosted: true })`, their `firebase/*` calls reach the dev server's sandbox as the server's own signed-in user, under your rules, and `firebase-admin/*` reaches it as admin. With the default SharedWorker sandbox, server code cannot reach the sandbox, so those calls fail with `failed-precondition` and say to set `hosted: true`.

```js
// src/routes/profile.server.js, loaded by your framework's dev SSR
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, set } from 'firebase/database';
import { firebaseConfig } from '../firebase-config.js';

const app = getApps()[0] ?? initializeApp(firebaseConfig);
const { user } = await signInAnonymously(getAuth(app));
await set(ref(getDatabase(app), `users/${user.uid}/lastSeen`), Date.now());
// Lands in the dev server's sandbox; Studio and firebase-admin see it.
```

Server code runs under your Realtime Database rules, and with no rules every read and write is denied, as in production. Without a rules file, this `set` fails with `PERMISSION_DENIED`. Add `database.rules.json` next to `vite.config.ts`, or at the path your `firebase.json` `database.rules` names, and allow each user their own path:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The sandbox reloads the rules when you save the file, but Vite keeps a server module whose evaluation failed. Restart the dev server, or save the server module, so Vite evaluates it again.

An import the swap doesn't serve stops instead of loading the real Firebase SDK: another `firebase/*` subpath such as `firebase/installations`, `firebase-admin` in browser code, or an installed package that imports `firebase` or `firebase-admin` itself. In the browser, the module throws `PYRIC_REAL_SDK_STOPPED` when it loads, naming the import and the file it would have loaded. In the dev server process, the import fails with the same error before the file loads, and the dev server log shows it once. Production AI mode's `firebase/ai` still loads the real SDK. Your Vite config's own imports load before the plugin does, so the stop can't see them; under `pyric sandbox -- vite dev` the register stops those too.

The plugin also runs the network guard in the dev server process. It refuses requests for a server-side Google access token, such as Google's OAuth 2.0 token endpoint and the GCE metadata server, so code in that process can't act with your machine's Google credentials. The dev server log names each refused host. Other hosts get through.

`PYRIC_GUARD=off` turns the guard off, and the stop stays on. Firebase AI Logic (`firebasevertexai.googleapis.com`) is not a token source, so in production AI mode (`ai: { mode: 'production' }`, `PYRIC_AI_MODE=production`, or `PYRIC_AI_PASSTHROUGH=1`) server-rendered `firebase/ai` calls reach it as you chose; in the default sandbox AI mode they fail with `failed-precondition`. The guard does not run during `vite build` or `vite preview`, and it does not affect browser code. See [Environment variables](../reference/cli.md#environment-variables).

## Start your local server

Run your normal Vite development server:

```bash
npm run dev
```

Vite serves the application and Pyric Studio simultaneously on the exact same local origin. Access Studio at `/__pyric/ui/studio` or by clicking the floating runtime chip in the bottom-right corner of the browser.

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

The plugin hot-reloads Security Rules whenever the file, or a rules file it imports, is saved. If omitted, Pyric checks `firestore.modules.rules`, `firebase.json`, and `firestore.rules` automatically.

## Choose the Firebase project

The project id names your default Realtime Database instance, selects the `.firebaserc` deploy targets a `firebase.json` `database` array names, and is the project your functions run as. Pass `project` when the plugin should run as a specific project. It takes a project id or a `.firebaserc` alias:

```ts
export default defineConfig({
  plugins: [
    pyric({
      project: 'staging',
    }),
  ],
});
```

Without the option, the plugin resolves the project the way the Firebase CLI does, and uses the first of these that is set:

1. The `project` option.
2. The `PYRIC_PROJECT` environment variable.
3. The project `firebase use` made active for this directory or a parent directory.
4. The only alias in `.firebaserc`, else `.firebaserc` `projects.default`.

A value that names a `.firebaserc` alias resolves to that alias's project id. Like the Firebase CLI, the plugin reads no other environment variable to choose the project.

When no project resolves, or the project does not map a deploy target, the server still starts. The log names each unmapped target and what it tried. That target's instances deny every read and write, or allow them under permissive mode, until your app's Firebase config names a project `.firebaserc` maps the target for. The sandbox then applies the target's rules and logs that it did.

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

## Serve production Storage URLs through your service worker

If your app has its own service worker, set `serviceWorker` to its source file (`pyric({ hosted: true, serviceWorker: 'src/sw.ts' })`). In dev, production Storage download URLs your pages load are then answered from the sandbox. See [Serve production download URLs from your service worker](../build/cloud-storage.md#serve-production-download-urls-from-your-service-worker).

## Enable Node host mode

To run the sandbox in a durable, shared Node process backed by SQLite instead of the browser's SharedWorker, pass `hosted: true`:

```ts
export default defineConfig({
  plugins: [
    pyric({
      hosted: true,
    }),
  ],
});
```

See [Node host mode](./node-host.md) for complete details on persistence, ports, and multi-client sharing.
