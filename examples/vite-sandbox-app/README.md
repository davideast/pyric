# vite-sandbox-app

Reference example: a Firebase web app built with **Vite** + the
`@pyric/cli/vite` plugin. This is the shape `pyric init --template web`
scaffolds, kept in-repo as a dogfood + the runtime-verified reference.

In development it runs entirely on pyric's in-process sandbox — no Firebase
project, credentials, or emulators.

- **Develop:** `bun run dev` — `vite dev` with the plugin swapping `firebase/*`
  to the sandbox: your `firestore.rules` deployed + hot-reloaded, popup sign-in.
- **Build for production:** `bun run build` — `vite build` ships the real
  `firebase` package. Fill `.env` from the Firebase console (see
  `.env.example`); the SAME config runs against real Firebase. No separate
  "graduation" step — dev and prod are one toolchain.
- **Deploy:** `bun run deploy:rules` then `bun run deploy:hosting`
  (`hosting.public` is `dist/`, Vite's build output).

The app code uses canonical `firebase/*` imports everywhere. Switching between
the sandbox and real Firebase is `vite dev` vs `vite build`, never what you
wrote.
