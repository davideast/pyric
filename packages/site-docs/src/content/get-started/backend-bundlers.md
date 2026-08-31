---
title: "Backend bundlers & Node dev tools"
navLabel: "Backend bundlers"
group: "Get started"
section: ""
order: 35
description: "Configure Rolldown, esbuild, tsup, and backend dev tooling to preserve local Pyric sandbox interception."
---

# Backend bundlers & Node dev tools

When you run `pyric sandbox [command...]`, Pyric injects `NODE_OPTIONS="--import @pyric/cli/register"` into your development process. This Node.js runtime loader intercepts calls to `firebase-admin` and `firebase`, transparently routing them into your local sandbox.

If your backend uses a bundler (such as Rolldown, esbuild, or tsup) during development, dependencies are compiled inline by default. When `firebase-admin` is bundled inline into an output file (such as `dist/server.js`), Node never resolves the package at runtime, and sandbox interception is bypassed.

This guide shows you how to configure your bundler to keep Firebase packages external so that `pyric sandbox` intercepts your backend services.

---

## 1. Import the externalisation presets

Install `@pyric/cli` as a development dependency if you have not already:

```bash
npm install -D @pyric/cli
```

Import `pyricExternals` from `@pyric/cli/bundler`:

```ts
import { pyricExternals } from '@pyric/cli/bundler';
```

---

## 2. Configure your bundler

Add the appropriate preset to your bundler's `external` configuration.

### If you use Rolldown (`rolldown.config.ts`)

Rolldown accepts regular expression patterns. Use the `rolldown` preset:

```ts
import { defineConfig } from 'rolldown';
import { pyricExternals } from '@pyric/cli/bundler';

export default defineConfig({
  input: 'src/server.ts',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  external: pyricExternals.rolldown,
});
```

### If you use esbuild (`esbuild.config.mjs`)

esbuild requires string arrays with wildcard patterns (`*`). Use the `esbuild` preset:

```js
import esbuild from 'esbuild';
import { pyricExternals } from '@pyric/cli/bundler';

await esbuild.build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  external: pyricExternals.esbuild,
});
```

### If you use tsup (`tsup.config.ts`)

tsup uses esbuild under the hood. Use the `tsup` preset:

```ts
import { defineConfig } from 'tsup';
import { pyricExternals } from '@pyric/cli/bundler';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  external: pyricExternals.tsup,
});
```

### If you use a custom predicate

For bundlers that support function-based external resolution (such as Rollup, Rolldown, Vite, or Webpack), use `isPyricExternal`:

```ts
import { isPyricExternal } from '@pyric/cli/bundler';

export default {
  external: (id) => isPyricExternal(id),
};
```

---

## 3. Run your development server under `pyric sandbox`

Add your bundler watch script and server runner to `package.json`:

```json
{
  "scripts": {
    "dev": "rolldown -c -w & node --watch dist/server.js",
    "build": "rolldown -c"
  }
}
```

Launch your application with `pyric sandbox`:

```bash
npx pyric sandbox
```

`pyric sandbox` starts the local sandbox, opens Pyric Studio, and executes your `dev` script. Because `firebase-admin` is externalised, your server's database, auth, and messaging operations route directly to the Pyric sandbox without requiring Google Cloud credentials or network access.

---

## 4. Unbundled workflows (no bundler needed)

If your development workflow does not bundle dependencies into an intermediate file—for example, if you run TypeScript files directly with `tsx` or native Node:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts"
  }
}
```

No bundler configuration is required. `pyric sandbox` intercepts your `firebase-admin` imports automatically out of the box.
