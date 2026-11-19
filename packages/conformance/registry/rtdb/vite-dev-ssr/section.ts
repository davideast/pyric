import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 260,
  prefix: "### Server-rendered modules under `vite dev`\n\nModules Vite loads for server rendering under `vite dev` with `pyric()` (`server.ssrLoadModule`, a runnable environment, a framework's SSR entry and loaders) get the modules a registered server process gets (#1123): the client SDKs reach the dev server's own Node host as one signed-in SSR session per dev server process, and `firebase-admin` reaches it as admin. This holds with Vite's default externalization and with `ssr.noExternal`. A SharedWorker dev server refuses them, naming `pyric({ hosted: true })`, and a server environment Vite does not run in its own process (workerd) gets a module that throws when it loads. In production these modules run the Firebase SDKs in the server's runtime and reach the project.\n",
  defaults: {
    section: "Client SDKs in a registered server process",
    status: "diverged-documented",
    automation: "unit-backed",
  },
});

export const row = section.row;
