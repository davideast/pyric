import { defineConfig } from 'vite';
import { pyricSandbox } from 'pyric-tools/vite';

// pyricSandbox() is DEV-ONLY. Under `vite dev` it swaps firebase/* to the
// in-process pyric sandbox and deploys + hot-reloads firestore.rules — no
// Firebase project, credentials, or emulators. `vite build` ships the real
// firebase package; the swap never reaches production output.
export default defineConfig({
  plugins: [pyricSandbox()],
});
