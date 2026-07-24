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

## Supervise your development server

Prefix your development start command with `pyric dev` in `package.json`:

```json
{
  "scripts": {
    "dev": "pyric dev -- next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

Start the supervised server with `npm run dev`. Pyric boots its sandbox host in the background, sets `PYRIC_SANDBOX` for server-side queries, and launches `next dev`.

## Understand the two-server architecture

Why does Next.js run two server processes while Vite runs one? Next.js doesn't expose Express or Connect custom middleware hooks. To preserve native compiling speed without requiring a custom server script, Pyric coordinates two processes:

```
Browser (http://localhost:3000)
  ├── Next.js App & UI     ──> Next Dev Server (Port 3000)
  ├── Pyric Studio (/ui)   ──> HTTP Rewrite Proxy  ──> Pyric Dev Host (Port 3473)
  └── SharedWorker Sandbox ──> Direct WebSocket    ──> Pyric Dev Host (Port 3473)
```

1. **Single-Origin Browser Access**: You only ever open your Next.js application port (`http://localhost:3000`). Next.js HTTP rewrites seamlessly proxy Pyric Studio (`/__pyric/ui/`) and storage routes through that single port. Because your app and Studio share this exact origin, they share the single browser `SharedWorker` that holds your active Firestore data and IndexedDB persistence.
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

When `pyric dev` supervises your Next.js process, server components and API routes automatically resolve Firebase Admin calls over the WebSocket bridge to your open browser tab.
