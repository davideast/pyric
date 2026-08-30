import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pyric } from '@pyric/cli/vite';
import path from 'node:path';

// Under `vite dev` pyric() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads the rules — no Firebase project,
// credentials, or emulators. `vite build` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under `pyric sandbox`, build with a
// non-production mode: `vite build --mode development` (see the `build:sandbox`
// script). That output is marked and can never be deployed.
export default defineConfig({
  plugins: [react(), tailwindcss(), pyric()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
