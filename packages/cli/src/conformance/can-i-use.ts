import {
  CONFORMANCE_IMPORT_EVIDENCE,
  CONFORMANCE_SUPPORTS,
  resolveCanIUse,
  resolveImportEvidence,
  type FeatureSupport,
} from './.generated/can-i-use.js';
import { createServedQuery } from './served-query.js';

/** Query the generated, build-time conformance support projection. */
export const canIUse = createServedQuery(CONFORMANCE_SUPPORTS, resolveCanIUse<FeatureSupport>);

/** Find the generated compatibility-page evidence for a published import. */
export function canIUseImport(importPath: string) {
  return resolveImportEvidence(CONFORMANCE_IMPORT_EVIDENCE, importPath);
}
