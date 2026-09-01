<p align="center">
  <img src="https://pyric.dev/pyric-logo.svg" alt="Pyric" width="180" />
</p>

<h1 align="center">A Firebase that runs inside your app</h1>

<p align="center">Keep the same <code>firebase/*</code> code. During <code>vite dev</code> those imports resolve to a local backend running in the page. A production build ships the real Firebase SDK, unchanged.</p>

<p align="center"><a href="https://pyric.dev">pyric.dev</a></p>

<br />

Application code stays canonical Firebase:

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

Run the Vite development server and supported Firebase imports resolve to a browser-local backend: Auth, Firestore with Security Rules, persistence in IndexedDB, one SharedWorker backend shared by every tab on the dev origin. Run a normal production build and those imports resolve to Firebase again. The application source does not branch between the two, and the local mirror never connects to a production project.

Coding agents get the same backend. A [skill](#start-with-a-coding-agent) sets up the sandbox end to end (`npx plugins add davideast/pyric`, then `/pyric`), and an opt-in MCP bridge lets an agent seed, inspect, and change the backend the app is already running against. `can-i-use` answers what conforms to real Firebase before the agent builds on it.

<img width="1512" height="947" alt="Pyric Studio showing local data, requests, authentication state, and Security Rules verdicts" src="https://github.com/user-attachments/assets/cb4a219c-c5f0-4fb7-8904-996416c0a79c" />

## Create a new app

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

During `vite dev`, the plugin swaps supported `firebase/*` modules at resolution time. Pyric Studio is available on the Vite origin at `/__pyric/ui/studio`. It opens the same backend used by the application.

For a static application or a Node process, `pyric sandbox` provides the same development-only package swap without the Vite plugin. The [CLI reference](packages/site-docs/src/content/reference/cli.md) documents those paths and every command.

## Start with a coding agent

Install the Pyric plugin:

```bash
npx plugins add davideast/pyric
```

Antigravity CLI and OpenCode use the standalone skill installer:

```bash
# Antigravity CLI
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric --agent antigravity-cli

# OpenCode
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric --agent opencode
```

Then invoke the skill:

| Agent | Enter |
|---|---|
| Codex | `$pyric` |
| Claude Code | `/pyric:pyric` |
| Antigravity CLI | `/pyric` |
| OpenCode | `/pyric` |

The leading `$` or `/` is part of the command.

The skill chooses the project launcher, starts one local sandbox bridge, opens the application, and confirms that the browser sandbox is connected.

An agent can also work through the MCP bridge directly. It keeps writing the same Firebase code while inspecting and changing the backend the application is already using. Agent access is opt-in:

```ts
pyric({
  bridge: true
});
```

The bridge mounts on the Vite development origin and routes agent operations to the same SharedWorker backend used by the application and Studio. This protects the local workflow, not an independently credentialed process. A coding agent with production Firebase credentials or deployment access can still affect production outside Pyric.

## Monitor the local environment in Pyric Studio

Pyric Studio shows local data, requests, authentication state, Security Rules verdicts, and denied operations. Open `/__pyric/ui/studio` on the development server and reproduce the failure. A denied request includes the path and verdict needed to correct the rule or the application code.

The Vite plugin discovers the Firestore rules path from `firebase.json`, or falls back to `firestore.rules`. Saving that file replaces the active local ruleset without a production deploy. A parse failure leaves the last valid ruleset active and reports the error in the development server.

State and test identities stay browser-local by default. Add `persist: true` to write a committable `.pyric/state/state.json`, or use `seed` to start from a known scenario:

```ts
pyric({
  persist: true,
  seed: 'seed.json',
});
```

See [persistence and multi-tab behavior](packages/site-docs/src/content/observe/shape-your-data.md) for reset and seed precedence.

## Verify the rules against production

Development sessions capture Firestore and Realtime Database operations in `.pyric/last-session.json` by default. Replay those requests against candidate rules before deployment:

```bash
npx pyric verify
```

The default engine runs locally. The optional Firestore Rules Test API engine sends derived rule cases to Google's hosted evaluator when production-authority verification is needed. It verifies rules and does not deploy them. See [verify against a captured session](packages/site-docs/src/content/ship/ship-to-production.md).

## Ship the same application code

A standard Vite production build leaves the development swap inactive:

```bash
npm run build
```

The built application contains the real Firebase SDK and uses the Firebase configuration already present in the source. Deploy the build, rules, and indexes with `firebase-tools` or the Firebase Console. Pyric has no production deployment path.

The mirrored data services do not connect to a production Firebase project. Local writes cannot delete production data or create Firebase usage charges, and local rules changes do not deploy. Pyric owns the development sandbox and verification workflow. Firebase owns production, with `firebase-tools` or the Firebase Console handling deployment.

Normal Auth, Firestore, Realtime Database, Storage, Messaging, and Firebase AI Logic usage still belongs in the [Firebase documentation](https://firebase.google.com/docs). Pyric documents the parts that differ locally, including supported behavior, Security Rules, persistence, inspection, verification, and known gaps. See [use the Vite plugin](packages/site-docs/src/content/get-started/vite.md) for the complete plugin contract.

## Check what Pyric mirrors

Pyric is an independent implementation of observable Firebase behavior. Conformance evidence records what has been compared with Firebase and keeps five outcomes distinct: conforms, documented divergence, bug, unsupported, and unverified. The evidence is a floor, not a claim that every Firebase behavior has been measured.

Ask about a developer-facing feature:

```bash
npx pyric can-i-use getAfter
npx pyric can-i-use firestore-rules/request.query --json
```

The result reports availability, Firebase fidelity, and assurance eligibility as separate axes. Exact names succeed; fuzzy input prints labeled suggestions and exits nonzero instead of presenting a guess as a trust answer.

Read the generated [conformance scores](https://pyric.dev/docs/conformance-scores/) and the service matrices in the site's Conformance section. They are built from the same canonical registry used by assurance and `canIUse`. Node consumers can query the same registry through [`@pyric/cli/conformance`](packages/site-docs/src/content/reference/cli.md). The [versioning and compatibility policy](packages/site-docs/src/content/trust/versioning-and-compatibility.md) explains the release boundary.

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

See [CONTEXT.md](CONTEXT.md) and [AGENTS.md](AGENTS.md) before changing the codebase.
