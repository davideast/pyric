# __PYRIC_PROJECT_NAME__

A full Firebase + Pyric reference chat app. It includes authentication,
conversation persistence, attachment storage, presence, streamed AI replies,
browser-based React app generation, Cloud Messaging, and RTDB-triggered Cloud
Functions.

## Start locally

```bash
npm install # or: bun install
npm run dev
```

With no model configuration, Pyric's built-in scripted engine answers locally.
To use Ollama, pull a model, copy `.env.example` to `.env.local`, and select it:

```bash
ollama pull qwen3:4b
```

```dotenv
PYRIC_AI_MODEL=qwen3:4b
```

Pyric forwards the unchanged `firebase/ai` calls to Ollama's default
OpenAI-compatible endpoint at `http://localhost:11434/v1`. For another model
server, also set its base URL (including `/v1` when required):

```dotenv
PYRIC_AI_MODEL=minimax-m2.7
PYRIC_AI_PROXY_UPSTREAM=http://localhost:8080/v1
```

Start the model server separately, then restart Vite.
See the [Pyric AI Logic guide](https://pyric.dev/docs/build/ai-logic/) for the full
engine and proxy behavior.

## What runs in the sandbox

During `npm run dev`, `@pyric/cli/vite` swaps the app's canonical `firebase/*`
imports to the browser sandbox. Firestore, Realtime Database, Storage, Auth,
Messaging, the MCP bridge, and the RTDB Functions child share that sandbox.

The source of truth for rules is `firestore.modules.rules`. Run
`npm run rules:resolve` before deploying to regenerate `firestore.rules`.

For native notifications, sign in and use the bell once to grant permission.
The same bundled module service worker handles `onBackgroundMessage` in local
development and production. Local delivery still requires an open page to keep
the Pyric sandbox alive.

## Test and build

```bash
npm test
npm run typecheck
npm run test:notifications
```

`npm run build` uses the real Firebase packages. Fill the `VITE_FIREBASE_*`
values in `.env.local`, resolve the rules, install the Functions dependencies,
and deploy with the Firebase CLI:

```bash
npm --prefix functions install
npm run rules:resolve
npm run build
npx firebase-tools deploy
```
