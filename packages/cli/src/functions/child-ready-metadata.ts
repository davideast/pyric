/**
 * Child-safe metadata collector for the Functions child IPC `ready` payload.
 *
 * Kept separate from host-side `multi-codebase-metadata.ts` so the isolated
 * user Functions child process never imports `pyric/sandbox` runtime modules,
 * while keeping `child.ts` well under the 600-line module budget.
 */
import type { FunctionsReadyTriggerInfo } from './child-protocol.js';
import { resolveEndpointRegionsOption } from './endpoint-options.js';
import {
  classifyEndpointOmit,
  endpointTriggerLabel,
  listFirebaseEndpoints,
} from './endpoints.js';
import type { DiscoveredOnRequest } from './http/discovery.js';
import type { ParamsEnvMap } from './params-resolver.js';

export interface ChildReadyMetadata {
  exportNames: string[];
  triggers: FunctionsReadyTriggerInfo[];
}

export function collectChildReadyMetadata(
  exported: Record<string, unknown>,
  httpFunctions: readonly DiscoveredOnRequest[],
  unsupportedNames: ReadonlySet<string>,
  env: ParamsEnvMap = process.env,
): ChildReadyMetadata {
  const httpByExport = new Map(httpFunctions.map((fn) => [fn.exportName, fn]));
  const exportNames: string[] = [];
  const triggers: FunctionsReadyTriggerInfo[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint) continue;
    if (classifyEndpointOmit(endpoint.omit, env) === 'omitted') continue;
    exportNames.push(exportName);
    if (unsupportedNames.has(exportName)) continue;

    const httpFn = httpByExport.get(exportName);
    if (httpFn !== undefined) {
      triggers.push({
        exportName,
        kind: httpFn.kind === 'callable' ? 'callable' : 'http',
        regions: httpFn.regions,
      });
      continue;
    }

    const entryInfo: FunctionsReadyTriggerInfo = {
      exportName,
      kind: endpointTriggerLabel(endpoint),
    };
    const resolvedRegions = resolveEndpointRegionsOption(endpoint.region, 'us-central1', env);
    if (resolvedRegions.ok && resolvedRegions.explicit) {
      entryInfo.regions = resolvedRegions.regions;
    }
    triggers.push(entryInfo);
  }

  return { exportNames, triggers };
}
