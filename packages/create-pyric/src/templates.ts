/**
 * Scaffold templates for `pyric init` (engine in `./init.js`).
 *
 * `web` (the default) scaffolds a **Vite app** wired to the `@pyric/cli/vite`
 * plugin: `vite dev` runs the app's CANONICAL `firebase/*` imports against the
 * in-process sandbox; `vite build` ships the real `firebase` package. One
 * toolchain, no graduation cliff — the sandbox↔Firebase swap is environmental
 * (dev vs build), never a code edit (the design rationale section 9).
 *
 * `static` is the serve-era scaffold (no bundler): a static app `pyric dev`
 * runs against the in-page sandbox via a runtime import map. For pre-built /
 * retrofit apps, or anyone who wants zero build step.
 *
 * `node` is the script-style scaffold (backend fixtures, agent loops). Its
 * canonical imports are swapped by the dev command and remain Firebase under
 * the production command.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXTJS_TEMPLATE } from './template-nextjs.js';

export const TEMPLATE_NAMES = ['web', 'node', 'static', 'chat', 'nextjs'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

export interface ScaffoldTemplate {
  /** package.json pieces merged into existing files / written into new ones. */
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** npm/bun `overrides` (optional). Vendor mode sets `{ pyric: file:… }` so a
   *  transitive `pyric` dep can't resolve to the published placeholder. */
  overrides?: Record<string, string>;
  /** Directories created before writing files (relative to the project dir). */
  dirs: string[];
  /** Scaffold-owned files, relative path → content. */
  files(name: string): Array<{ name: string; content: string }>;
  /** Literal commands for the report / `--json` consumers. */
  nextSteps: string[];
}

interface AssetManifest {
  include: string[];
}

interface AssetFile {
  name: string;
  content: string;
}

const ASSET_IGNORES = new Set([
  '.agents',
  '.codex',
  '.env',
  '.env.local',
  '.git',
  '.pyric',
  'bun.lock',
  'dist',
  'node_modules',
  'package-lock.json',
  'pnpm-lock.yaml',
  'test-results',
  'yarn.lock',
]);

/** Load one allowlisted packaged tree; the runnable tree is the scaffold source. */
export function loadAssetTemplate(templateName: string, templateRoot?: string): {
  packageJson: {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  dirs: string[];
  files: AssetFile[];
} {
  const root = resolve(
    templateRoot ?? fileURLToPath(new URL(`../templates/${templateName}/`, import.meta.url)),
  );
  const manifest = JSON.parse(readFileSync(resolve(root, 'scaffold.json'), 'utf8')) as AssetManifest;
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  if (!Array.isArray(manifest.include) || manifest.include.length === 0) {
    throw new Error(`create-pyric: template '${templateName}' has no scaffold include list`);
  }

  const files: AssetFile[] = [];
  const seenFiles = new Set<string>();
  const dirs = new Set<string>();
  const walk = (absolute: string): void => {
    if (ASSET_IGNORES.has(basename(absolute))) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`create-pyric: template '${templateName}' contains a symlink: ${absolute}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) walk(resolve(absolute, entry));
      return;
    }
    if (!stat.isFile()) {
      throw new Error(
        `create-pyric: template '${templateName}' contains a non-file asset: ${absolute}`,
      );
    }
    const rawRelative = relative(root, absolute).split(sep).join('/');
    const name = rawRelative === 'gitignore' ? '.gitignore' : rawRelative;
    if (seenFiles.has(name)) {
      throw new Error(`create-pyric: template '${templateName}' includes '${name}' more than once`);
    }
    seenFiles.add(name);
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) {
      throw new Error(
        `create-pyric: template '${templateName}' contains a binary asset: ${rawRelative}`,
      );
    }
    let parent = dirname(name).split(sep).join('/');
    while (parent !== '.') {
      dirs.add(parent);
      parent = dirname(parent).split(sep).join('/');
    }
    files.push({ name, content: bytes.toString('utf8') });
  };

  for (const entry of manifest.include) {
    if (!entry || isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      throw new Error(`create-pyric: template '${templateName}' has unsafe include '${entry}'`);
    }
    const absolute = resolve(root, entry);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`create-pyric: template '${templateName}' include escapes its root: '${entry}'`);
    }
    walk(absolute);
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return { packageJson, dirs: [...dirs].sort(), files };
}

// ─── web template ─────────────────────────────────────────────────────

const WEB_INDEX_HTML = (name: string): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
      button { padding: 0.4rem 0.9rem; cursor: pointer; }
      form { display: flex; gap: 0.5rem; margin: 1rem 0; }
      input { flex: 1; padding: 0.4rem 0.6rem; }
      ul { padding-left: 1.2rem; }
      .status { color: #666; }
    </style>
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p class="status" id="auth-status">Signed out</p>
      <button id="sign-in">Sign in with Google</button>
      <button id="sign-out" hidden>Sign out</button>
      <form id="add-post" hidden>
        <input id="post-title" placeholder="Post title" required />
        <button type="submit">Add post</button>
      </form>
      <ul id="posts"></ul>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;

const WEB_APP_JS = `// Canonical firebase/* imports. Under \`pyric dev\` they are served by the
// in-page pyric sandbox (the config below is ignored); under any standard
// bundler/pipeline the same imports resolve to the real \`firebase\` package.
// Graduation changes where you run this code, never the code itself.
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';

const app = initializeApp({
  // Graduation: your real web-app config from the Firebase console
  // (see .env.example). Unused while developing under \`pyric dev\`.
  apiKey: 'demo',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo',
});
const auth = getAuth(app);
const db = getFirestore(app);

const els = {
  status: document.getElementById('auth-status'),
  signIn: document.getElementById('sign-in'),
  signOut: document.getElementById('sign-out'),
  form: document.getElementById('add-post'),
  title: document.getElementById('post-title'),
  posts: document.getElementById('posts'),
};

els.signIn.addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
els.signOut.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  els.status.textContent = user
    ? 'Signed in as ' + (user.displayName ?? user.email)
    : 'Signed out';
  els.signIn.hidden = !!user;
  els.signOut.hidden = !user;
  els.form.hidden = !user;
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // The owner-based rules require uid == request.auth.uid on create.
  await addDoc(collection(db, 'posts'), {
    title: els.title.value.trim(),
    uid: auth.currentUser.uid,
    createdAt: serverTimestamp(),
  });
  els.title.value = '';
});

onSnapshot(collection(db, 'posts'), (snap) => {
  els.posts.replaceChildren(
    ...snap.docs.map((d) => {
      const li = document.createElement('li');
      li.textContent = d.data().title;
      return li;
    }),
  );
});
`;

const WEB_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Owner-based from line 1 — \`pyric dev\` hot-reloads this file and
    // ships a sign-in helper, so safe rules are cheap to iterate. These
    // deploy as-is.
    match /posts/{postId} {
      allow read: if true;
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid;
      allow update, delete: if request.auth != null
                            && resource.data.uid == request.auth.uid;
    }

    // Default deny — opt in per collection.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

const WEB_FIREBASE_JSON = `{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "hosting": {
    "public": "public",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
`;

const WEB_SEED_JSON = `{
  "posts/welcome": { "title": "Welcome to pyric", "uid": "seed" },
  "posts/sandboxed": { "title": "This page runs on the in-page sandbox", "uid": "seed" }
}
`;

const WEB_ENV_EXAMPLE = `# Graduation config — your real Firebase web app (console → project settings).
# Unused under \`pyric dev\`; wire it into public/app.js (or a bundler env)
# when you deploy against the real backend.
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
`;

const webReadme = (name: string): string => `# ${name}

A Firebase web app. In development it runs entirely on pyric's in-page
sandbox — no Firebase project, credentials, or emulators.

- **Develop:** \`bun install && bun run dev\` — serves \`public/\` with the
  sandbox standing in for Firebase: seeded data, rules enforced + hot-reloaded,
  popup sign-in via the helper dialog.
- **Agent:** \`bun run dev:agent\` — same, plus the MCP bridge on the dev-server
  origin (\`/__pyric/mcp\`).
- **Persist (optional):** \`pyric dev --persist --seed seed.json\` — data and
  test users survive reloads and restarts in \`.pyric/state/state.json\`
  (plain JSON; gitignored). Promote lived state to a committable fixture
  with \`pyric snapshot\`, then re-serve it: \`pyric dev --seed pyric-state.json\`.
- **Graduate:** fill \`.env\` from the Firebase console and point the config in
  \`public/app.js\` at it, then run \`npx firebase-tools deploy\`. Bare
  \`firebase/*\` imports need a bundler
  (e.g. \`vite build\`) or an import map in production — \`pyric dev\`
  provides the map in dev.

The app code uses canonical \`firebase/*\` imports everywhere. Switching
between sandbox and real Firebase is about **where you run it**, never what
you wrote.
`;

const GITIGNORE = `node_modules/
dist/
.env
.firebaserc
.pyric/
*.log
`;

const FIRESTORE_INDEXES = `{
  "indexes": [],
  "fieldOverrides": []
}
`;

// ─── node template (init v1 scaffold, carried over) ───────────────────

const NODE_APP_TS = `// Canonical Firebase imports stay unchanged between sandbox and production.
// \`bun run dev\` activates @pyric/cli/register; \`bun start\` loads Firebase.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { seed } from './seed.ts';

const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY ?? 'pyric-local',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID ?? 'pyric-local',
  appId: process.env.FIREBASE_APP_ID ?? 'pyric-local',
});
const db = getFirestore(app);

if (process.env.PYRIC_SANDBOX) {
  await seed(db);
}

const snap = await getDocs(collection(db, 'posts'));
console.log(\`\${snap.size} posts:\`);
snap.forEach((doc) => console.log(\`  \${doc.id}:\`, doc.data()));

// Production: fill .env, deploy firestore.rules, then \`bun start\`.
`;

const NODE_SEED_TS = `import { collection, addDoc, type Firestore } from 'firebase/firestore';

export async function seed(db: Firestore): Promise<void> {
  await addDoc(collection(db, 'posts'), {
    title: 'Hello, Pyric',
    author: 'sandbox',
    createdAt: new Date(),
  });
  await addDoc(collection(db, 'posts'), {
    title: 'Local-first by default',
    author: 'sandbox',
    createdAt: new Date(),
  });
}
`;

const NODE_ENV_EXAMPLE = `# Production Firebase config (Firebase console -> project settings).
# Sandbox development uses the fallback values in src/app.ts.
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_APP_ID=
`;

const NODE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Local-first defaults: open in the sandbox so the quickstart
    // works out of the box. **Tighten these before deploying with firebase-tools**
    // — anonymous read+write is not what you want
    // in the wild.
    match /posts/{postId} {
      allow read: if true;
      allow write: if true;
    }

    // Default deny for everything else — opt in per collection.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

const NODE_FIREBASE_JSON = `{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
`;

const nodeReadme = (name: string): string => `# ${name}

A Firebase app whose canonical imports run against Pyric in development and
real Firebase in production. No application-code switch is required.

## Quick start

\`\`\`bash
bun install
bun run dev        # Pyric sandbox through the Node package swap
bun start          # production: real Firebase
\`\`\`

## Use with an MCP-connected agent (Claude Code)

Install the pyric Claude Code plugin once. It auto-connects through a bundled
stdio proxy that discovers the running bridge from \`.pyric/serve.json\` and probes
both IPv4 + IPv6, so there is NO \`claude mcp add\` step and no hand-written URL (a
static \`127.0.0.1\` URL hits the loopback-family trap). Just start the bridge:

\`\`\`bash
pyric bridge       # default port 5174
\`\`\`

and the agent's pyric tools attach automatically.

## Graduating to a real Firebase project

Graduation is a command change, not a code edit:

1. Create a project at https://console.firebase.google.com and fill \`.env\`
   (see \`.env.example\`).
2. **Tighten \`firestore.rules\`** — the scaffolded rules are open for
   sandbox convenience.
3. Deploy them with the Firebase CLI: add a \`.firebaserc\`
   (\`{ "projects": { "default": "your-project-id" } }\`), then run
   \`npx firebase-tools deploy --only firestore:rules\`.
4. Run the same canonical-import code against the real backend: \`bun start\`.
`;

// ─── web template (Vite + @pyric/cli/vite) ───────────────────────────

const VITE_INDEX_HTML = (name: string): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
      button { padding: 0.4rem 0.9rem; cursor: pointer; }
      form { display: flex; gap: 0.5rem; margin: 1rem 0; }
      input { flex: 1; padding: 0.4rem 0.6rem; }
      ul { padding-left: 1.2rem; }
      .status { color: #666; }
    </style>
  </head>
  <body>
    <main>
      <h1>${name}</h1>
      <p class="status" id="auth-status">Signed out</p>
      <button id="sign-in">Sign in with Google</button>
      <button id="sign-out" hidden>Sign out</button>
      <!-- Visible even while signed out ON PURPOSE — submitting attempts the
           write and the owner-based rules deny it (see src/main.ts). -->
      <form id="add-post">
        <input id="post-title" placeholder="Post title" required />
        <button type="submit">Add post</button>
      </form>
      <ul id="posts"></ul>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const VITE_MAIN_TS = `// Canonical firebase/* imports — UNCHANGED between dev and prod.
// In \`vite dev\` the \`@pyric/cli/vite\` plugin swaps these to an in-process
// sandbox (the config below is accepted but ignored). \`vite build\` ships the
// real \`firebase\` package and uses the SAME config. Graduation is a build, not
// a code edit.
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';

const app = initializeApp({
  // Filled from .env (see .env.example) at \`vite build\` time for production.
  // Ignored in \`vite dev\` — the pyric sandbox stands in for Firebase.
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo',
});
const auth = getAuth(app);
const db = getFirestore(app);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  status: $('auth-status'),
  signIn: $<HTMLButtonElement>('sign-in'),
  signOut: $<HTMLButtonElement>('sign-out'),
  form: $<HTMLFormElement>('add-post'),
  title: $<HTMLInputElement>('post-title'),
  posts: $('posts'),
};

els.signIn.addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
els.signOut.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  els.status.textContent = user
    ? 'Signed in as ' + (user.displayName ?? user.email)
    : 'Signed out';
  els.signIn.hidden = !!user;
  els.signOut.hidden = !user;
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // The form stays visible while signed out ON PURPOSE: submitting then
  // ATTEMPTS the write, the owner-based rules deny it (create requires
  // uid == request.auth.uid), and the denial shows up in Pyric Studio's
  // Traffic tab — the rules-teaching loop this demo exists for.
  const user = auth.currentUser;
  try {
    await addDoc(collection(db, 'posts'), {
      title: els.title.value.trim(),
      uid: user?.uid ?? 'anonymous',
      createdAt: serverTimestamp(),
    });
    els.title.value = '';
  } catch (err) {
    els.status.textContent = user
      ? \`Write failed: \${(err as { code?: string }).code ?? String(err)}\`
      : 'Denied by rules (signed out) — see the Traffic tab in Pyric Studio.';
  }
});

onSnapshot(collection(db, 'posts'), (snap) => {
  els.posts.replaceChildren(
    ...snap.docs.map((d) => {
      const li = document.createElement('li');
      li.textContent = (d.data() as { title?: string }).title ?? '';
      return li;
    }),
  );
});
`;

const VITE_CONFIG = `import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

// Under \`vite dev\` pyric() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads firestore.rules — no Firebase project,
// credentials, or emulators. \`vite build\` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under \`pyric dev\`, build with a
// non-production mode: \`vite build --mode development\` (see the \`build:sandbox\`
// script). That output is marked and can never be deployed.
export default defineConfig({
  plugins: [pyric()],
});
`;

const VITE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`;

// Owner-based rules for the Vite web template. Same shape as the static
// template's WEB_RULES, but the comment reflects the plugin (not pyric dev) —
// keep this in lockstep with examples/vite-sandbox-app/firestore.rules.
const VITE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Owner-based from line 1 — the Vite plugin deploys + hot-reloads this file
    // into the sandbox, so safe rules are cheap to iterate. These deploy as-is.
    match /posts/{postId} {
      allow read: if true;
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid;
      allow update, delete: if request.auth != null
                            && resource.data.uid == request.auth.uid;
    }

    // Default deny — opt in per collection.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

const VITE_ENV_DTS = `/// <reference types="vite/client" />
`;

const VITE_FIREBASE_JSON = `{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "hosting": {
    "public": "dist",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
`;

const VITE_ENV_EXAMPLE = `# Your real Firebase web-app config (Firebase console -> project settings).
# UNUSED in \`vite dev\` (the pyric sandbox stands in); USED by \`vite build\` for
# production. Vite only exposes \`VITE_\`-prefixed vars to client code.
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
`;

const viteReadme = (name: string): string => `# ${name}

A Firebase web app built with Vite. In development it runs entirely on pyric's
in-process sandbox — no Firebase project, credentials, or emulators.

- **Develop:** \`bun install && bun run dev\` — \`vite dev\` with the
  \`@pyric/cli/vite\` plugin swapping \`firebase/*\` to the sandbox: seeded data,
  your \`firestore.rules\` deployed + hot-reloaded, popup sign-in.
- **Build for production:** \`bun run build\` — \`vite build\` ships the real
  \`firebase\` package. Fill \`.env\` from the Firebase console (see
  \`.env.example\`); the SAME config you wrote runs against real Firebase. There
  is no separate "graduation" step — dev and prod are one toolchain.
- **Deploy:** \`npx firebase-tools deploy\` after the production build
  (\`hosting.public\` is \`dist/\`, Vite's build output).

> Your app code uses canonical \`firebase/*\` imports everywhere. Switching
> between the sandbox and real Firebase is \`vite dev\` vs \`vite build\`, never
> what you wrote.

The plugin is dev-only: SharedWorker multi-tab sync, \`--persist\`, capture, and
the MCP bridge (all available today under \`pyric dev\`) arrive in the plugin in
later releases. For a pre-built / no-build app, use \`pyric init --template static\`
+ \`pyric dev\`.
`;

let chatAssets: ReturnType<typeof loadAssetTemplate> | undefined;
const getChatAssets = (): ReturnType<typeof loadAssetTemplate> =>
  (chatAssets ??= loadAssetTemplate('chat'));

// ─── the registry ─────────────────────────────────────────────────────

export const TEMPLATES: Record<TemplateName, ScaffoldTemplate> = {
  // web (default) — a Vite app on the @pyric/cli/vite plugin. `vite dev` runs
  // on the sandbox; `vite build` ships real firebase. One toolchain.
  web: {
    scripts: {
      dev: 'vite',
      build: 'vite build',
      'build:sandbox': 'vite build --mode development',
     preview: 'vite preview',
    },
    // The real firebase package ships day one so the production `vite build`
    // resolves the same canonical imports against it — no code edit at graduation.
    dependencies: { firebase: '^12.12.0' },
    devDependencies: { '@pyric/cli': '*', vite: '^6.0.0', typescript: '^5.7.0' },
    dirs: ['src'],
    files: (name) => [
      { name: 'index.html', content: VITE_INDEX_HTML(name) },
      { name: 'vite.config.ts', content: VITE_CONFIG },
      { name: 'tsconfig.json', content: VITE_TSCONFIG },
      { name: 'src/main.ts', content: VITE_MAIN_TS },
      { name: 'src/vite-env.d.ts', content: VITE_ENV_DTS },
      { name: 'firestore.rules', content: VITE_RULES },
      { name: 'firebase.json', content: VITE_FIREBASE_JSON },
      { name: 'firestore.indexes.json', content: FIRESTORE_INDEXES },
      { name: '.env.example', content: VITE_ENV_EXAMPLE },
      { name: 'README.md', content: viteReadme(name) },
      { name: '.gitignore', content: GITIGNORE },
    ],
    nextSteps: [
      'bun install',
      'bun run dev    # vite dev on the pyric sandbox',
      'bun run build  # production build against real Firebase',
    ],
  },
  node: {
    scripts: {
      start: 'node --env-file-if-exists=.env --experimental-strip-types src/app.ts',
      dev: 'pyric dev --no-open -- node --env-file-if-exists=.env --experimental-strip-types src/app.ts',
     bridge: 'pyric bridge',
    },
    dependencies: { firebase: '^12.12.0' },
    devDependencies: { '@pyric/cli': '*', '@types/node': '^22.0.0', typescript: '^5.7.0' },
    dirs: ['src'],
    files: (name) => [
      { name: 'src/app.ts', content: NODE_APP_TS },
      { name: '.env.example', content: NODE_ENV_EXAMPLE },
      { name: 'src/seed.ts', content: NODE_SEED_TS },
      { name: 'firestore.rules', content: NODE_RULES },
      { name: 'firebase.json', content: NODE_FIREBASE_JSON },
      { name: 'firestore.indexes.json', content: FIRESTORE_INDEXES },
      { name: 'README.md', content: nodeReadme(name) },
      { name: '.gitignore', content: GITIGNORE },
    ],
    nextSteps: ['bun install', 'bun run dev', 'bun start  # production: real Firebase'],
  },
  // static — the serve-era, no-bundler scaffold: a static app `pyric dev`
  // runs against the in-page sandbox via a runtime import map. For pre-built /
  // retrofit apps, or anyone who wants zero build step.
  static: {
    scripts: {
      dev: 'pyric dev --seed seed.json',
     'dev:agent': 'pyric dev --bridge --seed seed.json',
    },
    dependencies: { firebase: '^12.12.0' },
    devDependencies: { '@pyric/cli': '*' },
    dirs: ['public'],
    files: (name) => [
      { name: 'public/index.html', content: WEB_INDEX_HTML(name) },
      { name: 'public/app.js', content: WEB_APP_JS },
      { name: 'firestore.rules', content: WEB_RULES },
      { name: 'firebase.json', content: WEB_FIREBASE_JSON },
      { name: 'firestore.indexes.json', content: FIRESTORE_INDEXES },
      { name: 'seed.json', content: WEB_SEED_JSON },
      { name: '.env.example', content: WEB_ENV_EXAMPLE },
      { name: 'README.md', content: webReadme(name) },
      { name: '.gitignore', content: GITIGNORE },
    ],
    nextSteps: ['bun install', 'bun run dev', 'bun run dev:agent  # agents: MCP at /__pyric/mcp'],
  },
  chat: {
    // Asset-backed templates stay lazy. The standalone binary imports
    // create-pyric for ordinary CLI commands without embedding this package's
    // on-disk template tree; eager reads would make even `pyric --version`
    // fail before dispatch.
    get scripts() { return getChatAssets().packageJson.scripts; },
    get dependencies() { return getChatAssets().packageJson.dependencies; },
    get devDependencies() { return getChatAssets().packageJson.devDependencies; },
    get overrides() { return getChatAssets().packageJson.overrides; },
    get dirs() { return getChatAssets().dirs; },
    files: (name) => getChatAssets().files.map((file) => ({
      name: file.name,
      content: file.content.replaceAll('__PYRIC_PROJECT_NAME__', name),
    })),
    nextSteps: [
      'npm install       # or: bun install',
      'npm run dev       # scripted local AI by default',
      'npm run typecheck',
    ],
  },
  nextjs: NEXTJS_TEMPLATE,
};
