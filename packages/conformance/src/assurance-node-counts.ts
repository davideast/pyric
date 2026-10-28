/**
 * Per-service count check for the assurance verdict graph.
 *
 * Every assurance node belongs to exactly one service: a registry row belongs
 * to the registry that authors it (`registry/<service>.ts`, keyed by the
 * registry's `surface`), and a rules-language construct belongs to its engine
 * snapshot (`rules-language/<engine>.json`, keyed `<engine>-rules`). The
 * committed expectation is one directory per service under
 * `assurance-node-counts/`, named for the service key. A service's count is
 * the sum of its files: `base.json` holds `{ "nodes": N }`, and every other
 * file is one change, `{ "delta": n }` with `n` not zero, named for that change
 * (for example the issue number). Two changes to one service add two files, so
 * they merge without conflict and the sum still equals the merged count.
 *
 * The check fails when a service's node count differs from its committed
 * count, when a service has no count directory, when a count directory names
 * no service, and when a node has no owning service. Adding or removing a row
 * is therefore a deliberate, reviewable file in one service's directory.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowsForSurface, surfaceRegistries } from '../registry/index.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ASSURANCE_NODE_COUNTS_DIR = join(HERE, '..', 'assurance-node-counts');

const COUNTS_PATH = 'packages/conformance/assurance-node-counts';
const COUNT_FILE_NAME = /^[a-z0-9-]+\.json$/;
const BASE_FILE = 'base.json';

/** Repo-relative path of the count directory for one service, as messages name it. */
export function assuranceNodeCountDir(service: string): string {
  return `${COUNTS_PATH}/${service}/`;
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

/** Committed counts, one directory per service, each the sum of its files. */
export function loadAssuranceNodeCounts(dir: string = ASSURANCE_NODE_COUNTS_DIR): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of readdirSync(dir).sort()) {
    const isServiceDirectory = statSync(join(dir, entry)).isDirectory();
    if (!isServiceDirectory) {
      throw new Error(
        `${COUNTS_PATH}/${entry}: each service is a directory, ${COUNTS_PATH}/<service>/, holding base.json and delta files`,
      );
    }
    counts[entry] = serviceCount(join(dir, entry), entry);
  }
  return counts;
}

function serviceCount(dir: string, service: string): number {
  const shownDir = assuranceNodeCountDir(service);
  let sum = 0;
  for (const file of readdirSync(dir).sort()) sum += countFileValue(join(dir, file), file, `${shownDir}${file}`);
  if (sum < 0) throw new Error(`${shownDir}: files sum to ${sum}; a count cannot be negative`);
  return sum;
}

function countFileValue(path: string, file: string, shownPath: string): number {
  if (!COUNT_FILE_NAME.test(file)) {
    throw new Error(`${shownPath}: count file names must match ${COUNT_FILE_NAME.source}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: unknown; delta?: unknown };
  return file === BASE_FILE ? baseValue(parsed.nodes, shownPath) : deltaValue(parsed.delta, shownPath);
}

function baseValue(nodes: unknown, shownPath: string): number {
  const isNonNegativeInteger = Number.isInteger(nodes) && (nodes as number) >= 0;
  if (!isNonNegativeInteger) throw new Error(`${shownPath}: "nodes" must be a non-negative integer`);
  return nodes as number;
}

function deltaValue(delta: unknown, shownPath: string): number {
  const isNonZeroInteger = Number.isInteger(delta) && delta !== 0;
  if (!isNonZeroInteger) throw new Error(`${shownPath}: "delta" must be a non-zero integer`);
  return delta as number;
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
    const problem = serviceCountProblem(service, actual[service] ?? 0, committed[service]);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

function serviceCountProblem(service: string, derived: number, expected: number | undefined): string | undefined {
  const dir = assuranceNodeCountDir(service);
  if (expected === undefined) {
    return `${service}: ${derived} assurance nodes and no committed count; create ${dir}${BASE_FILE} with {"nodes": ${derived}}`;
  }
  if (derived === 0) {
    return `${service}: no assurance nodes, but ${dir} sums to ${expected}; delete ${dir} if the service was removed deliberately`;
  }
  if (derived === expected) return undefined;
  const delta = derived - expected;
  const change = delta < 0 ? `${-delta} removed` : `${delta} added`;
  return `${service}: ${derived} assurance nodes, ${dir} sums to ${expected} (${change}); `
    + `if the row change is deliberate, add ${dir}<change>.json with {"delta": ${delta}}, `
    + 'named for the change (for example the issue number)';
}
