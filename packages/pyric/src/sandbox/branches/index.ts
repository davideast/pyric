/**
 * `pyric/sandbox/branches` is the branch primitive's public surface.
 *
 * Re-exports only. The engine lives in `engine.ts`. The on-disk store lives in
 * `store.ts` and is published from its own subpath because it reads files.
 */
export { apply, diff, discard, fork, promote } from './engine.js';
export type { Branch, DiffTarget } from './engine.js';
