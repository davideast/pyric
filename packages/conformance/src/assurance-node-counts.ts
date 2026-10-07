/**
 * Per-service count check for the assurance verdict graph.
 *
 * Every assurance node belongs to exactly one service: a registry row belongs
 * to the registry that authors it (`registry/<service>.ts`, keyed by the
 * registry's `surface`), and a rules-language construct belongs to its engine
 * snapshot (`rules-language/<engine>.json`, keyed `<engine>-rules`). The
 * committed expectation is one file per service under `assurance-node-counts/`,
 * filename is the service key, so a change to one service's rows edits only
 * that service's count file.
 *
 * The check fails when a service's node count differs from its committed
 * count, when a service has no count file, when a count file names no
 * service, and when a node has no owning service. Adding or removing a row is
 * therefore a deliberate, reviewable edit to one small file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowsForSurface, surfaceRegistries } from '../registry/index.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ASSURANCE_NODE_COUNTS_DIR = join(HERE, '..', 'assurance-node-counts');

/** Repo-relative path of the count file for one service, as messages name it. */
export function assuranceNodeCountFile(service: string): string {
  return `packages/conformance/assurance-node-counts/${service}.json`;
}

/** Node id to owning service key, derived from the registries and the rules-language snapshots. */
export function assuranceNodeOwners(): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const claim = (id: string, service: string) => {
    const prior = owners.get(id);
    if (prior !== undefined && prior !== service) {
      throw new Error(`assurance node '${id}' is owned by both '${prior}' and '${service}'`);
    }
    owners.set(id, service);
  };
  for (const registry of surfaceRegistries) {
    for (const row of rowsForSurface(registry)) claim(row.id, registry.surface);
  }
  for (const snapshot of Object.values(loadAllSnapshots())) {
    for (const construct of snapshot.constructs) claim(construct.id, `${snapshot.engine}-rules`);
  }
  return owners;
}

/** Committed counts, one `<service>.json` file per service. */
export function loadAssuranceNodeCounts(dir: string = ASSURANCE_NODE_COUNTS_DIR): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const service = file.slice(0, -'.json'.length);
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { nodes?: unknown };
    if (!Number.isInteger(parsed.nodes) || (parsed.nodes as number) < 0) {
      throw new Error(`${assuranceNodeCountFile(service)}: "nodes" must be a non-negative integer`);
    }
    counts[service] = parsed.nodes as number;
  }
  return counts;
}

/**
 * Problems between the assurance nodes the model derived and the committed
 * per-service counts (empty means they agree).
 */
export function assuranceNodeCountProblems(
  nodeIds: Iterable<string>,
  owners: ReadonlyMap<string, string> = assuranceNodeOwners(),
  committed: Readonly<Record<string, number>> = loadAssuranceNodeCounts(),
): string[] {
  const problems: string[] = [];
  const actual: Record<string, number> = {};
  for (const id of nodeIds) {
    const service = owners.get(id);
    if (service === undefined) {
      problems.push(`assurance node '${id}' has no owning registry or rules-language snapshot`);
      continue;
    }
    actual[service] = (actual[service] ?? 0) + 1;
  }
  const services = [...new Set([...Object.keys(actual), ...Object.keys(committed)])].sort();
  for (const service of services) {
    const derived = actual[service] ?? 0;
    const expected = committed[service];
    const file = assuranceNodeCountFile(service);
    if (expected === undefined) {
      problems.push(`${service}: ${derived} assurance nodes and no committed count; create ${file} with {"nodes": ${derived}}`);
    } else if (derived === 0) {
      problems.push(`${service}: no assurance nodes, but ${file} commits ${expected}; delete ${file} if the service was removed deliberately`);
    } else if (derived !== expected) {
      const change = derived < expected ? `${expected - derived} removed` : `${derived - expected} added`;
      problems.push(`${service}: ${derived} assurance nodes, ${file} commits ${expected} (${change}); if the row change is deliberate, set "nodes" to ${derived} in ${file}`);
    }
  }
  return problems;
}
