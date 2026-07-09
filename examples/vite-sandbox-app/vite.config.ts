import { defineConfig } from 'vite';
import { pyricSandbox } from 'pyric-tools/vite';

// Under `vite dev` pyricSandbox() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads firestore.rules — no Firebase project,
// credentials, or emulators. `vite build` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under `pyric dev`, build with a
// non-production mode: `vite build --mode development` (see the `build:sandbox`
// script). That output is marked and can never be deployed.
export default defineConfig({
  plugins: [pyricSandbox()],
});
