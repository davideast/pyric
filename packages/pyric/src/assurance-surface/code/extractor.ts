/**
 * Backwards-compatible {@link AccessSiteReport} projection over the unified
 * {@link extractSdkUsage} static analysis pass.
 */
import { buildOperationIndex, isWriteOp } from './operation-specs.js';
import type { SdkServiceModel } from './service-models/types.js';
import type {
  AccessSite,
  AccessSiteCounts,
  AccessSiteReport,
  ExtractAccessSitesOptions,
} from './types.js';
import { extractSdkUsage } from './usage-index.js';

export function extractAccessSites(options: ExtractAccessSitesOptions): AccessSiteReport {
  const usage = extractSdkUsage(options);
  const accessSites = [...usage.operations];
  return {
    accessSites,
    counts: countSites(accessSites, options.serviceModels),
    filesScanned: usage.filesScanned,
    projects: [...usage.projects],
    embeddedRules: [...usage.embeddedRules],
  };
}

export function countSites(
  sites: readonly AccessSite[],
  serviceModels?: readonly SdkServiceModel[],
): AccessSiteCounts {
  let extraWriteOps: ReadonlySet<string> | undefined;
  if (serviceModels && serviceModels.length > 0) {
    extraWriteOps = buildOperationIndex(serviceModels).writeOps;
  }
  const counts: AccessSiteCounts = {
    total: sites.length,
    writes: 0,
    reads: 0,
    resolved: 0,
    partial: 0,
    unresolved: 0,
  };
  for (const s of sites) {
    if (isWriteOp(s.op, extraWriteOps)) counts.writes += 1;
    else if (s.op === 'get' || s.op === 'query') counts.reads += 1;
    counts[s.resolution] += 1;
  }
  return counts;
}
