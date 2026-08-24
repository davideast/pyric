---
title: "Run Firebase locally"
navLabel: "Quickstart"
group: "Get started"
section: ""
order: 10
description: "Start a new Firebase application or add Pyric to an existing Vite application without connecting development to production."
---

# Run Firebase locally

Pyric adds a development-only resolution layer to a Firebase application. During Vite development, supported `firebase/*` imports resolve to a browser-local backend. A normal production build resolves those imports to Firebase again.

## Start with a coding agent

Install the Pyric plugin:

```bash
npx plugins add davideast/pyric
```

Antigravity CLI and OpenCode use the standalone skill installer:

```bash
# Antigravity CLI
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric-start --agent antigravity-cli

# OpenCode
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric-start --agent opencode
```

Then invoke the skill:

| Agent | Enter |
|---|---|
| Codex | `$pyric-start` |
| Claude Code | `/pyric:pyric-start` |
| Antigravity CLI | `/pyric-start` |
| OpenCode | `/pyric-start` |

The leading `$` or `/` is part of the command.

The skill selects the project launcher, starts one local sandbox bridge, opens the application, and confirms that the browser sandbox is connected.

## Start from the terminal

Create a new Vite or Next.js application with canonical Firebase imports, Firestore rules, and Pyric already configured:

```bash
# Start a Vite application
npm create pyric@latest my-app

# Or start a Next.js application
npm create pyric@latest my-app -- --template nextjs

cd my-app
npm install
npm run dev
```

Open the local URL printed by the development server. The application and Pyric Studio use the exact same local backend. Studio is at `/__pyric/ui/studio` on that origin.

Pyric also adds a small, collapsed runtime chip in the bottom-right corner. It stays quiet while the sandbox is healthy and signals when there is an error to inspect or a newer worker to activate. [Resolve runtime errors and stale workers](../observe/resolve-runtime-status.md) covers both actions.

## Add Pyric to an existing application

Install the CLI and development plugins as a development dependency:

```bash
npm install --save-dev @pyric/cli
```

### Vite
Add it to the Vite configuration:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyric()],
});
```

### Next.js

Update the Next.js configuration in `next.config.mjs`:

```ts
import { fileURLToPath } from 'node:url';
import { withPyric } from '@pyric/cli/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Existing config
};

export default withPyric(nextConfig);
```

Start the normal development server:

```bash
npm run dev
```

No application imports change. Continue using `firebase/app`, `firebase/auth`, `firebase/firestore`, and the other supported Firebase entry points. Pyric uses an explicit rules configuration first, then discovers `firestore.modules.rules`, the path in `firebase.json`, or `firestore.rules`, in that order.

## Use a static application or Node process

`pyric dev` provides the same development-only package swap outside the Vite plugin:
```bash
npm install --save-dev @pyric/cli
npx pyric dev
```
It can serve static files or start an existing development command. The CLI guide covers those paths. [Test in Node](../ship/test-in-node.md) covers an in-process sandbox for tests and scripts.

## What remains local

The mirrored services do not connect to a production Firebase project. Local data changes stay in the sandbox. Local Security Rules changes are enforced there and are not deployed. Firebase configuration passed to `initializeApp(config)` is accepted so the application code stays unchanged, but it does not select a cloud backend during development.

Continue with [How the swap works](./how-the-swap-works.md), then [develop with the Firebase APIs](../build/authentication.md).
