/**
 * `pyric/rules/internal/node`: the engine moved to `@pyric/rules/internal/node` (#1521).
 * This entry re-exports it, so every name it had keeps resolving here.
 * The names below are pyric's own and stay in this package.
 */
export * from '@pyric/rules/internal/node';

// Tool factories — `createFirestoreRulesTools` wraps resolver +
// linter + simulator + test handlers into agent-runtime tools.
// Lives on /node because the resolver dep is Node-only.
export {
  createFirestoreRulesTools,
  createFirestoreSimulatorTools,
} from '../tools.js';
export type {
  FirestoreRulesToolDeps,
  FirestoreSimulatorToolDeps,
} from '../tools.js';
// Rules stdlib discovery/resolution tools, including retained
// Firestore-prefixed compatibility aliases.
export { createFirestoreRulesStdlibTools } from '../stdlib-tools.js';
