/** The docs projection: every conformance page (per-service compatibility
 * matrices plus the public API coverage scoreboard) fully rendered at package
 * build from the central conformance model. Consumers display these pages —
 * the docs site is one such consumer — they never re-derive the model. */
export {
  CONFORMANCE_DOCS_PAGES,
  type ConformanceDocsPage,
} from './.generated/conformance-docs.js';
