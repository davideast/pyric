// Shared runtime loader for policy-oracle probes.
// Resolves @pyric/rules exports from ORACLE_ROOT/arcade/runtime/package.json
// (works under both `oracle.py --all` and sandboxed `--candidate-package`),
// or from an explicit package entry URL for local unit tests.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveOracleRoot(override) {
  const root = override ?? process.env.ORACLE_ROOT;
  if (!root || typeof root !== 'string') {
    throw new Error('ORACLE_ROOT is not set; run under oracle.py or pass oracleRoot');
  }
  return root;
}

export function createRulesRuntime(options = {}) {
  const {
    oracleRoot,
    packageBaseUrl,
    directModules,
  } = options;
  const cache = new Map();

  function baseUrl() {
    if (packageBaseUrl) return packageBaseUrl;
    const root = resolveOracleRoot(oracleRoot);
    return pathToFileURL(join(root, 'arcade/runtime/package.json')).href;
  }

  async function loadSubpath(subpath) {
    const key = subpath || '.';
    if (directModules && Object.hasOwn(directModules, key)) {
      return directModules[key];
    }
    if (!cache.has(key)) {
      const specifier = subpath ? '@pyric/rules/' + subpath : '@pyric/rules';
      const resolved = import.meta.resolve(specifier, baseUrl());
      cache.set(key, import(resolved));
    }
    return cache.get(key);
  }

  return {
    rules: () => loadSubpath(''),
    policy: () => loadSubpath('experimental/policy'),
    internal: () => loadSubpath('internal'),
    storageInternal: () => loadSubpath('internal/storage'),
    rtdbInternal: () => loadSubpath('internal/rtdb'),
  };
}

export function unsupportedOutcomes(caseIds, compilerError) {
  const values = Object.fromEntries(caseIds.map((id) => [id, 'UNSUPPORTED']));
  return {
    candidate: { ...values },
    mutant: { ...values },
    artifacts: { compilerError: String(compilerError) },
  };
}

export async function tryCompile(compileFn, caseIds) {
  try {
    return { ok: true, value: await compileFn() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, result: unsupportedOutcomes(caseIds, message), error: message };
  }
}
