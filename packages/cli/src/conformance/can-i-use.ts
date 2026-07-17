import {
  CONFORMANCE_IMPORT_EVIDENCE,
  CONFORMANCE_SUPPORTS,
  resolveCanIUse,
  resolveImportEvidence,
  type CanIUseOptions,
  type FeatureSupport,
} from './.generated/can-i-use.js';

/** Query the generated, build-time conformance support projection. */
export function canIUse(query: string, options?: CanIUseOptions) {
  return resolveCanIUse<FeatureSupport>(CONFORMANCE_SUPPORTS, query, options);
}

/** Find the generated compatibility-page evidence for a published import. */
export function canIUseImport(importPath: string) {
  return resolveImportEvidence(CONFORMANCE_IMPORT_EVIDENCE, importPath);
}
