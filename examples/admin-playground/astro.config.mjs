import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

const shimDir = fileURLToPath(new URL('./src/lib/node-shims', import.meta.url));

/**
 * Static-output Astro app — the admin-playground is a component
 * showcase. Components mount via React islands; all interactivity
 * lives client-side. Mirrors `examples/playground-next/`'s setup
 * so the design tokens + font loading transfer cleanly.
 *
 * Node-stdlib shims: `@pyric/firestore-rules`'s resolver module
 * hard-imports `fs`/`path`/`url` at top level. The showcase never
 * invokes the resolver (no `setRules` calls), but the imports have
 * to resolve for the Vite browser build. The aliases below point
 * each module at a small shim that throws if actually called.
 */
export default defineConfig({
  output: 'static',
  integrations: [react(), tailwind({ applyBaseStyles: true })],
  vite: {
    resolve: {
      alias: [
        { find: /^fs$/, replacement: `${shimDir}/fs.ts` },
        { find: /^path$/, replacement: `${shimDir}/path.ts` },
        { find: /^url$/, replacement: `${shimDir}/url.ts` },
      ],
    },
  },
});
