---
title: "Next.js development setup"
navLabel: "Next.js"
group: "Get started"
section: ""
order: 30
description: "Configure Next.js client component aliasing, dev rewrites, and supervised development execution."
---

# Next.js development setup

Use Pyric with Next.js, App Router, and Turbopack.

## Wrap your Next.js configuration

Import `withPyric` from `@pyric/cli/next` in your `next.config.mjs`:

```js
import { withPyric } from '@pyric/cli/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Existing config
};

export default withPyric(nextConfig);
```

`withPyric` aliases your client-side `firebase/*` imports to the local browser sandbox and registers development HTTP rewrites that forward `/__pyric/*` requests to your local Pyric backend.

### What `withPyric` changes

| Setting | Webpack | Turbopack |
|---|---|---|
| Client `firebase/*` imports | `resolve.alias` in client compiles | `resolveAlias` |
| Node built-ins in client code | `resolve.fallback` sets `fs`, `path` and `url` to empty modules | unchanged |
| Server imports of `firebase` and `firebase-admin` | `serverExternalPackages` | `serverExternalPackages` |

Each alias names a module `@pyric/cli` exports, such as `firebase/firestore` to `@pyric/cli/next/internal/firestore`, so both bundlers resolve it from your project's dependencies. The aliased specifiers are `firebase/ai`, `firebase/analytics`, `firebase/app`, `firebase/app-check`, `firebase/auth`, `firebase/database`, `firebase/firestore`, `firebase/firestore/lite`, `firebase/functions`, `firebase/messaging`, `firebase/messaging/sw`, `firebase/performance`, `firebase/remote-config` and `firebase/storage`. `@firebase/*` packages are never aliased, so internal SDK plumbing stays untouched.

Unmodeled client subpaths (`firebase/analytics`, `firebase/app-check`, `firebase/firestore/lite`, `firebase/functions`, `firebase/performance` and `firebase/remote-config`) go to Pyric's deferred entries. Imports resolve so module graphs load, and calling an export throws `PyricDeferredApiError` naming that subpath instead of crashing inside an uninitialized Firebase container or reaching production services.

Server components and route handlers keep `firebase` and `firebase-admin` external, so the `@pyric/cli/register` hook that `pyric sandbox` preloads routes them to the sandbox at runtime. Under `pyric sandbox --hosted`, `firebase/database`, `firebase/firestore`, `firebase/auth` and `firebase/storage` in server code reach the Node host as the server process's own signed-in user. Against the browser-hosted sandbox they fail with `failed-precondition`; use `firebase-admin` in server code there.

## Supervise your development server

Prefix your development start command with `pyric sandbox` in `package.json`:

```json
{
  "scripts": {
    "dev": "pyric sandbox -- next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

Start the supervised server with `npm run dev`. Pyric boots its sandbox host in the background, sets `PYRIC_SANDBOX` for server-side queries, and launches `next dev`.

`pyric sandbox --persist -- next dev` doesn't save state yet: the host refuses the browser's saves through the Next.js rewrite, so `.pyric/state/state.json` is never written. Track the fix in [#1194](https://github.com/davideast/pyric/issues/1194).

## Understand the two-server architecture

Why does Next.js run two server processes while Vite runs one? Next.js doesn't expose Express or Connect custom middleware hooks. To preserve native compiling speed without requiring a custom server script, Pyric coordinates two processes:

```
Browser (http://localhost:3000)
  ├── Next.js App & UI     ──> Next Dev Server (Port 3000)
  ├── Pyric Studio (/ui)   ──> HTTP Rewrite Proxy  ──> Pyric Dev Host (Port 3473)
  └── SharedWorker Sandbox ──> Direct WebSocket    ──> Pyric Dev Host (Port 3473)
```

1. **Single-Origin Browser Access**: You only ever open your Next.js application port (`http://localhost:3000`). Next.js HTTP rewrites seamlessly proxy Pyric (`/__pyric/*`) and Studio (`/__pyric/ui/studio`) through that single port. Because your app and Studio share this exact origin, they share the single browser `SharedWorker` that holds your active Firestore data and IndexedDB persistence.
2. **Direct WebSocket Synchrony**: Next.js development rewrites proxy standard HTTP traffic but cannot forward WebSockets (`Upgrade: websocket`). To synchronize real-time edits between your open browser tab and server-side Route Handlers, the browser runtime bypasses the rewrite proxy to connect its WebSocket bridge directly to port 3473.

## Server-side Admin SDK queries

Rely on supervised execution to route Node.js `firebase-admin` queries into your active browser tab:

```ts
// src/app/api/status/route.ts
import { NextResponse } from 'next/server';
import { getFirestore } from 'firebase-admin/firestore';

export async function GET() {
  const db = getFirestore();
  const snapshot = await db.collection('posts').get();
  return NextResponse.json({ count: snapshot.size });
}
```

When `pyric sandbox` supervises your Next.js process, server components and API routes automatically resolve Firebase Admin calls over the WebSocket bridge to your open browser tab.

## Configure or disable the runtime chip

Pass explicit options to `withPyric` to disable or expand the floating browser status chip during local development:

```js
// next.config.mjs
import { withPyric } from '@pyric/cli/next';

const nextConfig = {};

export default withPyric(nextConfig, {
  runtimeChip: false, // Pass { initiallyOpen: true } to launch expanded
});
```

`withPyric` propagates your chip preference down to client runtime bundles automatically during local builds. No HTML transformations or layout component edits are required.
