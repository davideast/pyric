/**
 * `pyric/rules/internal`: the engine moved to `@pyric/rules/internal` (#1521).
 * This entry re-exports it, so every name it had keeps resolving here.
 * The names below are pyric's own and stay in this package.
 */
export * from '@pyric/rules/internal';

// ─── Rules Test API client ───────────────────────────────────────────
export { TestFirestoreRulesHandler } from '../test/handler.js';
// ─── Tool factories (Slice 8) — Node-only ────────────────────────────
// `createFirestoreRulesTools` wraps the resolver (Node-only) into
// agent tools, so the factory itself is Node-only. Values live on
// `pyric/rules/internal/node`; types stay here so consumers in
// either environment can describe tool deps without dragging Node
// imports along.
export type {
  FirestoreRulesToolDeps,
  FirestoreSimulatorToolDeps,
} from '../tools.js';
export { createFirestoreSimulatorTools } from '../simulator.js';
export { createFirestoreRulesStdlibTools } from '../stdlib-tools.js';
// Composite-index extractor: static analysis of JS/TS source for the modular
// Firestore client's `query(collection(...), where(...), orderBy(...))` pattern.
// The VALUE exports (extractIndexes, the handler, the tool) live on the
// `pyric/rules/extract` subpath, NOT here: the extractor statically imports the
// TS compiler (~10MB), and a root re-export drags it into EVERY browser app that
// reaches `pyric/rules` via `pyric/firestore` but never extracts (Vite's dep
// optimizer bundles bare-specifier deps wholesale and follows dynamic imports,
// so neither tree-shaking nor lazy-loading keeps it out). See `./extract.ts`.
// The erasable TYPES stay here (type-only exports compile away, never bundled).
export type { ExtractIndexesOptions } from '../indexes/extractHandler.js';
// Composite-index detection over a structured query shape, not source text.
// `needsCompositeIndex` and `shapeToIndexEntry` have no TypeScript-compiler
// dependency (pure data functions over `QueryShape`), unlike the source-text
// extractor above, so they stay on this browser-safe entry rather than the
// compiler-heavy `pyric/rules/extract` subpath. A caller that already has a
// query's collection path, filters, and orderings (a recorded sandbox query,
// or one an agent names directly) reaches these without paying for the parser.
export {
  needsCompositeIndex,
  shapeToIndexEntry,
  indexEntryKey,
} from '../indexes/extract/composite.js';
export type {
  ExtractResult,
  ExtractionWarning,
  ExtractionSignal,
  ExtractOptions,
  QueryShape,
  Filter as IndexFilter,
  Order as IndexOrder,
  Fragment as IndexFragment,
  QueryBaseDecl,
  AnnotationApplied,
} from '../indexes/extract/types.js';
export type {
  ApiScope,
  ArrayConfig,
  Density,
  Index,
  IndexField,
  IndexFieldOrder,
  IndexOperation,
  IndexState,
  IndexesConfig,
  IndexesConfigEntry,
  QueryScope,
  VectorConfig,
} from '../indexes/types.js';
// ─── Rules deploy (write) — Firebase Rules API client ─────────────────
// Takes ProjectScope (per F3). Pairs with `firestore_test_rules`
// (also takes ProjectScope) and `lintFirestoreRules` / `validateFirestoreRules`
// in the same package — full rules lifecycle on one surface.
export { WriteFirestoreRulesHandler } from '../write/handler.js';
// ─── Rules inspect (read) — Firebase Rules API client ─────────────────
// Fetches + parses the deployed Firestore ruleset (list + get latest),
// returns AST + summary + validator findings. Takes ProjectScope (per
// F3). Browser-safe — REST + Bearer token only, no firebase-admin.
// Pairs with WriteFirestoreRulesHandler on the write side.
export { InspectFirestoreRulesHandler } from '../inspect/handler.js';
export { createFirestoreInspectTool } from '../inspect/tools.js';
export type { FirestoreInspectToolDeps } from '../inspect/tools.js';
