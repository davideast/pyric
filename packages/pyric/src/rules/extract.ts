/**
 * `@pyric/firestore-rules/extract`: composite-index extractor entry.
 *
 * The extractor statically analyzes JS/TS source (via the TypeScript compiler)
 * for the modular Firestore client's `query(collection(...), where(...),
 * orderBy(...))` pattern. The TS compiler is large (~10MB) and optimizer-
 * hostile, so it lives on its OWN subpath rather than the `pyric/rules` root
 * barrel.
 *
 * Why a subpath and not the root: every app that imports `firebase/firestore`
 * reaches `pyric/rules` (via `pyric/firestore`), and Vite's dep optimizer
 * bundles a bare-specifier dep WHOLESALE, so it cannot tree-shake an entry's
 * exports, and it follows dynamic imports; a root re-export (static OR
 * lazy) drags the whole TS compiler into every browser bundle and trips the
 * optimizer. Keeping the extractor here means `pyric/rules` stays compiler-free
 * for apps that never extract; browser callers that DO extract (the playground)
 * and Node callers (the MCP) opt in by importing `pyric/rules/extract`.
 *
 * (The erasable extractor TYPES stay re-exported from the root barrel too, since
 * type-only exports compile away and never reach a bundle.)
 */
export { extractIndexes } from './indexes/extract/extractor.js';
export { ExtractFirestoreIndexesHandler } from './indexes/extractHandler.js';
export { createFirestoreExtractTool } from './indexes/extractTool.js';
export type { ExtractIndexesOptions } from './indexes/extractHandler.js';
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
} from './indexes/extract/types.js';
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
} from './indexes/types.js';
