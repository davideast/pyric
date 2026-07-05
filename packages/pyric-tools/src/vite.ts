/**
 * `pyric-tools/vite` — the dev-only Vite plugin that swaps `firebase/*` to the
 * in-process pyric sandbox during `vite dev` (the serve analog for source-driven
 * apps). See `./serve/vite-plugin.ts` and the design rationale.
 *
 *   import { pyricSandbox } from 'pyric-tools/vite';
 *   export default defineConfig({ plugins: [pyricSandbox()] });
 */
export { pyricSandbox } from './serve/vite-plugin.js';
export type { PyricSandboxOptions } from './serve/vite-plugin.js';
