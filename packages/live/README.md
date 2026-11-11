# @pyric/live

Live mode for pyric. Your app's own Firebase SDK talks to your real Firebase
project, with its real data, and pyric shows each Firestore, Realtime Database
and Auth call with production's answer in the chip, Studio and the terminal.

```sh
npm install --save-dev @pyric/live
```

Requires `firebase` `^12.12.0` in your app.

For a Vite app:

```ts
import { defineConfig } from 'vite';
import { pyricLive } from '@pyric/live/vite';

export default defineConfig({ plugins: [pyricLive()] });
```

For a Node process against a running live host:

```sh
npx pyric-live run --wait -- node server.js
# or directly:
node --import @pyric/live/register server.js
```

Without a Vite dev server, start the live host with `npx pyric-live`.

Live mode forwards your app's Firestore, Realtime Database, Auth and App Check
calls and refuses pyric's own writes, other Firebase services and named
Firestore databases before any request leaves. Every read, write and listener
delivery is billed by production. The guide: https://pyric.dev/docs/observe/live-mode/
