/**
 * Node-only entry point.
 *
 * Anything that imports `node:fs` / `node:path` / `node:url` at
 * module-init lives here, so the browser-facing root entry stays
 * free of Node builtins. Consumers running in Node (admin tools,
 * SDK agent definitions, tests) import from `pyric/rules/internal/node`.
 *
 * Today the only Node-only surface is the modules resolver — it
 * reads stdlib files off disk via `readFileSync`.
 */

export {
  resolveModules,
  sanitizeModuleName,
  loadModule,
  prefixPrivateFunctions,
  rewriteCalls,
} from '../modules/resolver.js';
export type { ResolveResult, ResolveOptions } from '../modules/resolver.js';

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

// Composite-index generation tool — wraps the Layer 1 extractor with disk
// reads (`paths`) and an optional `out` write. Node-only: writes go through
// `node:fs/promises`. Lives beside the extractor's browser-safe factory
// (`createFirestoreExtractTool`, on `pyric/rules/extract`) rather than
// replacing it, since that factory stays reachable from browser bundles.
export { createFirestoreIndexesTools } from '../indexes/tools.js';

// Rules stdlib discovery/resolution tools, including retained
// Firestore-prefixed compatibility aliases.
export { createFirestoreRulesStdlibTools } from '../stdlib-tools.js';

// RTDB rules generation — `writeRtdbRulesFile` writes a compiled
// `defineRtdbRules(...).toJSON()` result to a static
// `database.rules.json` file. Lives on /node because it touches disk;
// the compilation itself stays in the isomorphic `pyric/rules/rtdb`
// entry (serializeRtdbRules via RtdbRulesDocument#toJSON).
export { writeRtdbRulesFile } from '../rtdb/constraints/write-rules-file.js';
