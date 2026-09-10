/**
 * The one place the `functions` tool's methods reach the RTDB trigger
 * runtime from a project directory, rather than each method repeating the
 * "where does this project keep its Functions source" question.
 *
 * `discoverFunctionsRtdbProject` answers three ways: no `firebase.json`, or a
 * `firebase.json` with no `functions` key, both mean the project declares no
 * Functions source and this reports an empty discovery rather than an error;
 * a declared source that does not resolve (a missing directory, a malformed
 * config) throws, which this lets propagate, because that is a project
 * mistake rather than an absent capability.
 */
import {
  inspectOnValueCreated,
  type DiscoveredOnValueCreated,
  type UnsupportedOnValueCreated,
} from '../../functions-rtdb/discovery.js';
import { loadFunctionsModuleExports } from '../../functions-rtdb/module-loader.js';
import { discoverFunctionsRtdbProject } from '../../functions-rtdb/project.js';

export interface FunctionsDiscovery {
  /** Where this project's Functions source was looked for. */
  lookedAt: string;
  triggers: DiscoveredOnValueCreated[];
  unsupported: UnsupportedOnValueCreated[];
}

/** Discover the RTDB triggers one project's Functions source defines, if it has one. */
export async function discoverFunctionsTriggers(projectDir: string): Promise<FunctionsDiscovery> {
  const lookedAt = `${projectDir}/firebase.json`;
  const project = discoverFunctionsRtdbProject(projectDir);
  if (project === null) return { lookedAt, triggers: [], unsupported: [] };
  const exported = await loadFunctionsModuleExports(project.entry);
  const inspected = inspectOnValueCreated(exported);
  return { lookedAt, triggers: inspected.triggers, unsupported: inspected.unsupported };
}
