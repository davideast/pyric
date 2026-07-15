<p align="center">
  <img src="https://pyric.dev/pyric-logo.svg" alt="Pyric" width="180" />
</p>

<h1 align="center">Build with Firebase without touching production</h1>

<p align="center">Keep the same <code>firebase/*</code> code. Pyric runs it against a local backend during development, then gets out of the way when the app ships to Firebase.</p>

<p align="center"><a href="https://pyric.dev">pyric.dev</a></p>

<br />

Pyric adds a development-only resolution layer to a Firebase application. Run the Vite development server and supported Firebase imports resolve to a browser-local backend. Run a normal production build and those imports resolve to Firebase again. The application source does not branch between the two.

The mirrored data services do not connect to a production Firebase project. Local writes cannot delete production data or create Firebase usage charges, and local rules changes do not deploy. Pyric owns the development sandbox and verification workflow. Firebase owns production, with `firebase-tools` or the Firebase Console handling deployment.

## Start a new Firebase application locally

Create a Vite application with canonical Firebase imports, Firestore rules, and the Pyric development plugin already configured:

```bash
npx create-pyric my-app
cd my-app
npm install
npm run dev
```

`npm create pyric my-app` runs the same scaffold.

## Run an existing Firebase application locally

Install the development plugin:

```bash
npm install --save-dev @pyric/cli
```

Add it to the existing Vite configuration:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```

Start the normal development server:

```bash
npm run dev
```

During `vite dev`, the plugin swaps supported `firebase/*` modules at resolution time. The backend runs in a SharedWorker, so tabs on the same development origin use one local backend. Browser-local persistence uses IndexedDB.

Pyric Studio is available on the Vite origin at `/__pyric/ui/`. It opens the same backend used by the application.

For a static application or a Node process, `pyric dev` provides the same development-only package swap without the Vite plugin. The [CLI reference](packages/cli/docs/reference/cli.md) documents those paths and every command.

## Keep writing Firebase code

Application code continues to import Firebase:

```ts
// src/firebase.ts
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
```

The Firebase configuration is accepted by the local mirror during development. The production build passes that same configuration to Firebase. Normal Auth, Firestore, Realtime Database, Storage, Messaging, and Firebase AI Logic usage still belongs in the [Firebase documentation](https://firebase.google.com/docs).

Pyric documents the parts that differ locally, including supported behavior, Security Rules, persistence, inspection, verification, and known gaps. See [use the Vite plugin](packages/cli/docs/how-to/use-the-vite-plugin.md) for the complete plugin contract.

## Inspect and correct a failed operation

Pyric Studio shows local data, requests, authentication state, Security Rules verdicts, and denied operations. Open `/__pyric/ui/` on the development server and reproduce the failure. A denied request includes the path and verdict needed to correct the rule or the application code.

The Vite plugin discovers the Firestore rules path from `firebase.json`, or falls back to `firestore.rules`. Saving that file replaces the active local ruleset without a production deploy. A parse failure leaves the last valid ruleset active and reports the error in the development server.

State and test identities stay browser-local by default. Add `persist: true` to write a committable `.pyric/state/state.json`, or use `seed` to start from a known scenario:

```ts
pyricSandbox({
  persist: true,
  seed: 'seed.json',
});
```

See [persistence and multi-tab behavior](packages/cli/docs/how-to/serve-persistence-and-multi-tab.md) for reset and seed precedence.

## Give coding agents the same local Firebase target

An agent can keep writing the same Firebase code while inspecting and changing the backend that the application is already using. Agent access is opt-in. Enable the MCP bridge in the Vite plugin:

```ts
pyricSandbox({ bridge: true });
```

The bridge mounts on the Vite development origin and routes agent operations to the same SharedWorker backend used by the application and Studio. The included [Claude Code plugin](pyric-plugin/README.md) discovers that bridge, while other MCP clients can connect to its HTTP endpoint.

This protects the local workflow, not an independently credentialed process. A coding agent with production Firebase credentials or deployment access can still affect production outside Pyric.

## Verify the rules boundary

Development sessions capture Firestore and Realtime Database operations in `.pyric/last-session.json` by default. Replay those requests against candidate rules before deployment:

```bash
npx pyric verify
```

The default engine runs locally. The optional Firestore Rules Test API engine sends derived rule cases to Google's hosted evaluator when production-authority verification is needed. It verifies rules and does not deploy them. See [verify against a captured session](packages/cli/docs/how-to/verify-against-a-captured-session.md).

## Ship the same application code

A standard Vite production build leaves the development swap inactive:

```bash
npm run build
```

The built application contains the real Firebase SDK and uses the Firebase configuration already present in the source. Deploy the build, rules, and indexes with `firebase-tools` or the Firebase Console. Pyric has no production deployment path.

## Check what Pyric mirrors

Pyric is an independent implementation of observable Firebase behavior. Conformance evidence records what has been compared with Firebase and keeps five outcomes distinct: conforms, documented divergence, bug, unsupported, and unverified. The evidence is a floor, not a claim that every Firebase behavior has been measured.

Read the generated matrices for [App](packages/pyric/docs/app/COMPAT.md), [Auth](packages/pyric/docs/auth/COMPAT.md), [Firestore](packages/pyric/docs/firestore/COMPAT.md), [Realtime Database](packages/pyric/docs/database/COMPAT.md), [Storage](packages/pyric/docs/storage/COMPAT.md), [Messaging](packages/pyric/docs/messaging/COMPAT.md), [AI Logic](packages/pyric/docs/ai/COMPAT.md), [Security Rules](packages/pyric/docs/rules/COMPAT.md), and [Functions with Realtime Database](packages/cli/docs/functions-rtdb/COMPAT.md). The [versioning and compatibility policy](packages/pyric/docs/explanation/versioning-and-compatibility.md) explains the release boundary.

## Stability

Pyric is alpha software, currently `0.1.0-alpha.8`. Firebase-shaped surfaces are tracked through the compatibility matrices. Pyric-specific development APIs may change between alpha releases. All packages are ESM-only and require Node 22.15 or later.

## Develop Pyric

The repository is a Bun workspace:

```bash
bun install
bun run build
bun run test
bun run compat:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CONTEXT.md](CONTEXT.md), and [AGENTS.md](AGENTS.md) before changing the codebase.
