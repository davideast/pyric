import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

// Under `vite dev` pyric() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads firestore.rules — no Firebase project,
// credentials, or emulators. `vite build` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under `pyric sandbox`, build with a
// non-production mode: `vite build --mode development` (see the `build:sandbox`
// script). That output is marked and can never be deployed.

// A custom avatar generator lives in its own file so this config stays
// small. The pyric example app ships vite.avatars.ts with a worked example
// that calls an image API; write your own function of the same shape to
// use the `avatars.source` option below.
// import { nanoBananaAvatar } from './vite.avatars';

export default defineConfig({
  plugins: [
    pyric({
      // Profile photos for provider sign-ins. The default needs no
      // configuration: every federated sign-in gets a deterministic
      // generated avatar. Comment exactly one option back in to try the
      // alternatives.

      // Firebase-null behaviour — photoURL stays null and the avatar
      // route unmounts:
      // avatars: false,

      // A pre-created avatar set: a directory holding a manifest.json and
      // image files; each user is deterministically assigned one:
      // avatars: './avatars',

      // Generate each user's photo once, on demand, with the function
      // named in the commented import above:
      // avatars: { source: nanoBananaAvatar },
    }),
  ],
});
