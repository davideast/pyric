/**
 * Where each method record runs.
 *
 * A record marked `runsIn: 'sandbox'` will run wherever the sandbox lives,
 * including a SharedWorker in a browser (#1469). Its module graph must
 * therefore import nothing that exists only in Node, and dispatch no
 * in-process tool family, because those families (the rules engine, captures,
 * conformance, the auth identity tools) are built only in the bridge process.
 * The type of its handler's context already keeps it off the project
 * directory; these checks cover what a type cannot see.
 *
 * The graph is read statically, the way a bundler would follow it: every value
 * import of a source file under `src/` is followed, and every bare specifier
 * is a leaf.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import {
  readRecordSource,
  renderSandboxManifest,
  runsInOf,
  sandboxSources,
  surfaceSources,
} from '../../../../scripts/generate-surface-manifest.js';
import { toolFamilies } from '../../../../src/bridge/tool-families.js';
import { METHODS } from '../../../../src/bridge/surface/methods/registry.js';
import {
  SANDBOX_METHODS_BY_KEY,
  sandboxMethodByKey,
} from '../../../../src/bridge/surface/methods/sandbox-registry.js';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SURFACE_DIRECTORY = join(PACKAGE_ROOT, 'src', 'bridge', 'surface');
const SERVER_DIRECTORY = join(PACKAGE_ROOT, 'src', 'bridge', 'server');

/**
 * Packages and package entries that run only in Node. Node's own builtins are
 * caught by `isBuiltin`. pyric's other entries are what the browser sandbox
 * bundle already serves; these three read and write a real file system.
 */
const NODE_ONLY_PACKAGES: readonly string[] = [
  '@modelcontextprotocol/sdk',
  'esbuild',
  'fake-indexeddb',
  'ws',
  'pyric/rules/internal/node',
  'pyric/sandbox/branches/store',
  'pyric/sandbox/checkpoints/directory',
];

/** The tool names the in-process families serve, which exist only in the bridge process. */
const IN_PROCESS_TOOL_NAMES: readonly string[] = toolFamilies('in-process').flatMap((family) =>
  Object.keys(family.tools),
);

const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** A relative specifier resolved to its TypeScript source, or null when it names no source file. */
function resolveSource(from: string, specifier: string): string | null {
  const target = resolve(dirname(from), specifier);
  const candidates = [target.replace(/\.js$/, '.ts'), `${target}.ts`, join(target, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface GraphEdge {
  /** The source file that imports it, relative to the package root. */
  from: string;
  /** The specifier as written, or the source file it resolved to. */
  to: string;
}

/** Every source file and bare specifier one entry reaches through value imports. */
function moduleGraph(entry: string): { files: string[]; bare: GraphEdge[] } {
  const files = new Set<string>();
  const bare: GraphEdge[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      const isRelative = path.startsWith('.');
      if (!isRelative) {
        bare.push({ from: relative(PACKAGE_ROOT, file), to: path });
        continue;
      }
      const source = resolveSource(file, path);
      if (source !== null) pending.push(source);
    }
  }
  return { files: [...files], bare };
}

function isNodeOnly(specifier: string): boolean {
  return isBuiltin(specifier) || NODE_ONLY_PACKAGES.includes(specifier);
}

/** Why one entry's graph cannot run in a browser, one line per reason. */
function browserViolations(entry: string): string[] {
  const { files, bare } = moduleGraph(entry);
  const violations: string[] = [];
  for (const edge of bare) {
    if (isNodeOnly(edge.to)) violations.push(`${edge.from} imports Node-only '${edge.to}'`);
  }
  for (const file of files) {
    const path = relative(PACKAGE_ROOT, file);
    const isServerModule = file.startsWith(SERVER_DIRECTORY);
    if (isServerModule) violations.push(`reaches the bridge server module ${path}`);
    const source = readFileSync(file, 'utf8');
    for (const name of IN_PROCESS_TOOL_NAMES) {
      const namesTool = source.includes(`'${name}'`) || source.includes(`"${name}"`);
      if (namesTool) violations.push(`${path} dispatches in-process tool '${name}'`);
    }
  }
  return violations;
}

function recordPath(key: string): string {
  const [tool, method] = key.split('.');
  return join(SURFACE_DIRECTORY, 'methods', tool!, `${method}.ts`);
}

const SANDBOX_KEYS = METHODS.filter((method) => method.runsIn === 'sandbox').map((method) => method.key);

describe('records that run where the sandbox lives', () => {
  it('declare where they run on every record', () => {
    for (const method of METHODS) expect(['sandbox', 'bridge']).toContain(method.runsIn);
  });

  it('import nothing Node-only and dispatch no in-process tool family', () => {
    const violations = SANDBOX_KEYS.flatMap((key) =>
      browserViolations(recordPath(key)).map((reason) => `${key}: ${reason}`),
    );
    expect(violations).toEqual([]);
  });

  it('are exactly the records the sandbox manifest loads', () => {
    expect([...SANDBOX_METHODS_BY_KEY.keys()].sort()).toEqual([...SANDBOX_KEYS].sort());
  });

  it('are found by key, and a bridge-side key is not', () => {
    expect(sandboxMethodByKey('firestore.getDoc')?.runsIn).toBe('sandbox');
    expect(sandboxMethodByKey('rules.set')).toBeUndefined();
  });

  it('load through a sandbox registry whose whole graph runs in a browser', () => {
    const registry = join(SURFACE_DIRECTORY, 'methods', 'sandbox-registry.ts');
    const context = join(SURFACE_DIRECTORY, 'sandbox-context.ts');
    expect([...browserViolations(registry), ...browserViolations(context)]).toEqual([]);
  });

  it('regenerate the sandbox manifest to what is in the tree', () => {
    const sources = surfaceSources(readdirSync(join(SURFACE_DIRECTORY, 'tools')), (tool) =>
      readdirSync(join(SURFACE_DIRECTORY, 'methods', tool)),
    );
    expect(renderSandboxManifest(sandboxSources(sources, readRecordSource))).toBe(
      readFileSync(join(SURFACE_DIRECTORY, 'manifest.sandbox.generated.ts'), 'utf8'),
    );
  });
});

describe('the check itself', () => {
  it('fails a sandbox-side graph that reaches a Node-only module', () => {
    expect(browserViolations(recordPath('firestore.writeIndexes'))).toContainEqual(
      "src/bridge/surface/methods/firestore/writeIndexes.ts imports Node-only 'node:fs'",
    );
    expect(browserViolations(recordPath('sandbox.checkpoint'))).toContainEqual(
      "src/bridge/surface/checkpoints.ts imports Node-only 'pyric/sandbox/checkpoints/directory'",
    );
  });

  it('fails a sandbox-side graph that dispatches an in-process tool family', () => {
    expect(browserViolations(recordPath('rules.listStdlib'))).toContainEqual(
      "src/bridge/surface/methods/rules/listStdlib.ts dispatches in-process tool 'rules_stdlib_list'",
    );
  });

  it('refuses a record that does not say where it runs', () => {
    expect(() => runsInOf('firestore', 'getDoc', "export default { tool: 'firestore' }")).toThrow(
      "methods/firestore/getDoc.ts declares no runsIn",
    );
  });
});
