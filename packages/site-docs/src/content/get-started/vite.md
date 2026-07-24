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

Vite serves the application and Pyric Studio simultaneously on the exact same local origin. Access Studio at `/__pyric/ui/` or by clicking the floating runtime chip in the bottom-right corner of the browser.

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
