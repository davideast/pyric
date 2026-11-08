/**
 * Access-site extraction: what a client app reads and writes in Firestore
 * and the Realtime Database, read from its source with the TypeScript
 * checker. Internal module; not part of the package exports yet.
 */
export { extractAccessSites, countSites } from './extractor.js';
export { isWriteOp } from './operation-specs.js';
export type { EmbeddedRules } from './embedded-rules.js';
export type {
  AccessPreset,
  AccessResolution,
  AccessService,
  AccessSite,
  AccessSiteCounts,
  AccessSiteReport,
  AuthProvenance,
  AuthSource,
  ExtractAccessSitesOptions,
  PathVariable,
  PayloadField,
  PayloadShape,
  QueryConstraint,
} from './types.js';
