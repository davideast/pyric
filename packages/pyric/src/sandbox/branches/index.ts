/**
 * `pyric/sandbox/branches` is the branch primitive's public surface.
 *
 * Re-exports only. The engine lives in `engine.ts`, the cross-service diff in
 * `state-diff.ts`, and the promotion delta in `promotion.ts`. The on-disk
 * store lives in `store.ts` and is published from its own subpath because it
 * reads files.
 */
export { apply, diff, discard, fork, promote } from './engine.js';
export type { Branch, BranchCandidateRules, DiffTarget } from './engine.js';
export { diffFullStates } from './state-diff.js';
export type { BranchDivergence, TreeChange } from './state-diff.js';
export { promoteFullState } from './promotion.js';
