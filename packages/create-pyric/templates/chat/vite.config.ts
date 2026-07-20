import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pyric } from '@pyric/cli/vite';
import path from 'node:path';

// Under `vite dev` pyric() swaps firebase/* to the in-process pyric
// sandbox and deploys + hot-reloads the rules — no Firebase project,
// credentials, or emulators. `vite build` (mode production) ships the real
// firebase package; the swap never reaches the deployed artifact. For a
// self-contained sandbox preview you can serve under `pyric dev`, build with a
// non-production mode: `vite build --mode development` (see the `build:sandbox`
// script). That output is marked and can never be deployed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyUpstream = env.PYRIC_AI_PROXY_UPSTREAM;
  const model = env.PYRIC_AI_MODEL;
  if (Boolean(proxyUpstream) !== Boolean(model)) {
    throw new Error(
      'PyChat local AI configuration requires both PYRIC_AI_PROXY_UPSTREAM and PYRIC_AI_MODEL.',
    );
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      pyric({
        bridge: true,
        // The authored 2+modules source is the source of truth; the plugin
        // resolves it in-memory, so no vendored firestore.rules is needed in
        // dev. `npm run rules:resolve` still generates it for Firebase deploy.
        rules: 'firestore.modules.rules',
        ...(proxyUpstream && model
          ? {
              ai: {
                proxyUpstream,
                engine: {
                  kind: 'openai' as const,
                  model,
                  modelMap: { 'gemini-2.5-flash': model },
                },
              },
            }
          : {}),
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
