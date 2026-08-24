<p align="center">
  <img src="https://pyric.dev/pyric-logo.svg" alt="Pyric" width="180" />
</p>

<h1 align="center">A local first Firebase development framework built for Agents</h1>

<p align="center">Keep the same <code>firebase/*</code> code. Pyric runs it against a local backend during development, then gets out of the way when the app ships to Firebase.</p>

<p align="center"><a href="https://pyric.dev">pyric.dev</a></p>

<br />

Pyric adds a development-only resolution layer to a Firebase application. Run the Vite development server and supported Firebase imports resolve to a browser-local backend. Run a normal production build and those imports resolve to Firebase again. The application source does not branch between the two.

The mirrored data services do not connect to a production Firebase project. Local writes cannot delete production data or create Firebase usage charges, and local rules changes do not deploy. Pyric owns the development sandbox and verification workflow. Firebase owns production, with `firebase-tools` or the Firebase Console handling deployment.

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

The skill chooses the project launcher, starts one local sandbox bridge, opens the application, and confirms that the browser sandbox is connected.

## Start from the terminal

Create a Vite application with canonical Firebase imports, Firestore rules, and the Pyric development plugin already configured:

```bash
npm create pyric@latest my-app
cd my-app
npm install
npm run dev
```

## Run an existing Firebase application locally

Install the development plugin:

```bash
npm install --save-dev @pyric/cli
```

Add it to the existing Vite configuration:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyric()],
});
```

Start the normal development server:

```bash
npm run dev
```

During `vite dev`, the plugin swaps supported `firebase/*` modules at resolution time. The backend runs in a SharedWorker, so tabs on the same development origin use one local backend. Browser-local persistence uses IndexedDB.

Pyric Studio is available on the Vite origin at `/__pyric/ui/studio`. It opens the same backend used by the application.

For a static application or a Node process, `pyric dev` provides the same development-only package swap without the Vite plugin. The [CLI reference](packages/cli/docs/reference/cli.md) documents those paths and every command.

## Keep using official Firebase SDKs

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

## Monitor the local environment in Pyric Studio

Pyric Studio shows local data, requests, authentication state, Security Rules verdicts, and denied operations. Open `/__pyric/ui/studio` on the development server and reproduce the failure. A denied request includes the path and verdict needed to correct the rule or the application code.

<img width="1512" height="947" alt="image" src="https://github.com/user-attachments/assets/cb4a219c-c5f0-4fb7-8904-996416c0a79c" />

The Vite plugin discovers the Firestore rules path from `firebase.json`, or falls back to `firestore.rules`. Saving that file replaces the active local ruleset without a production deploy. A parse failure leaves the last valid ruleset active and reports the error in the development server.

State and test identities stay browser-local by default. Add `persist: true` to write a committable `.pyric/state/state.json`, or use `seed` to start from a known scenario:

```ts
pyric({
  persist: true,
  seed: 'seed.json',
});
```

See [persistence and multi-tab behavior](packages/cli/docs/how-to/serve-persistence-and-multi-tab.md) for reset and seed precedence.

## Connect Coding Agents to the Sandbox using the Pyric MCP server

An agent can keep writing the same Firebase code while inspecting and changing the backend that the application is already using. Agent access is opt-in. Enable the MCP bridge in the Vite plugin:

```ts
pyric({ 
  bridge: true 
});
```

The bridge mounts on the Vite development origin and routes agent operations to the same SharedWorker backend used by the application and Studio.

This protects the local workflow, not an independently credentialed process. A coding agent with production Firebase credentials or deployment access can still affect production outside Pyric.

## Verify the rules against production 

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

Ask about a developer-facing feature without nesting discovery under rules verification:

```bash
npx pyric can-i-use getAfter
npx pyric can-i-use firestore-rules/request.query --json
```

The result reports availability, Firebase fidelity, and assurance eligibility as separate axes. Exact names succeed; a name shared by multiple surfaces asks you to qualify it, and fuzzy input prints labeled suggestions and exits nonzero instead of presenting a guess as a trust answer.

Documentation and other Node consumers can bind the same feature name to the
published import that exposes it, without maintaining a second surface map:

```ts
import { canIUse, canIUseImport } from '@pyric/cli/conformance';

const result = canIUse('getDownloadURL', { importPath: 'pyric/storage' });
const evidence = canIUseImport('pyric/storage');
const evidencePage = evidence && `/docs/${evidence.evidenceSlug}/`;
```

Each support result carries only census-proven `importPaths`; registry ownership
cannot invent package exports. `canIUseImport()` supplies the separate canonical
import-to-evidence join used by generated API documentation. An unrelated
import path returns no exact match rather than borrowing another surface's trust
claim.

Read the generated [conformance scores](https://pyric.dev/docs/conformance-scores/) and the service matrices in the site's Conformance section. They are built from the same canonical registry used by assurance and `canIUse`, without committing duplicate Markdown. The [versioning and compatibility policy](packages/pyric/docs/explanation/versioning-and-compatibility.md) explains the release boundary.

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
