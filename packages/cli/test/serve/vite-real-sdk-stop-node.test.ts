/**
 * The real `firebase` and `firebase-admin` never load in the Vite dev server
 * process, and the browser gets the stop for what pyric doesn't serve (#1906).
 *
 * From Node 24.16, `module.registerHooks` resolve hooks also run for
 * `require.resolve`, so the swap's own lookup of the installed file met
 * pyric's stop hook (or the register's mapping) and skipped the stop. Each
 * case runs a real Node process, plain with the plugin's stop hook and under
 * `--import @pyric/cli/register`, and imports the swap from `dist`, so build
 * the CLI first. PYRIC_TEST_NODE optionally selects the Node executable; CI
 * runs this on Node 22.15 and on Node 24.16.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = new URL('../../dist/', import.meta.url).href;
const REGISTER = new URL('../../dist/register/index.js', import.meta.url).href;

/** Imports pyric serves no browser module for: the swap must answer each with the stop. */
const UNSERVED = ['firebase-admin', 'firebase-admin/app', 'firebase/installations', 'firebase/compat/app'];

/** A file of the real client or admin SDK, by the package directory it sits in. */
const REAL_SDK_FILE = /\/node_modules\/(?:firebase|firebase-admin|@firebase\/[^/]+)\//;

interface NodeOutcome {
  readonly specifier: string;
  readonly via: 'import' | 'require';
  /** `loaded`, or the code of the error the load threw. */
  readonly result: string;
  readonly message?: string;
}

interface ChildReport {
  readonly node: string;
  readonly browser: Record<string, { id: string | null; source: string | null }>;
  readonly outcomes: NodeOutcome[];
  readonly loaded: string[];
}

/**
 * The child: record every file Node loads, install the plugin's stop hook
 * when the register is not active, ask the swap for each unserved import as
 * a page would, then load each in this process by import and by require.
 */
const CHILD = String.raw`
import Module, { createRequire } from 'node:module';
import path from 'node:path';
const [dist, appRoot, mode, list] = process.argv.slice(1);
const specifiers = JSON.parse(list);
const loaded = [];
Module.registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
if (mode === 'plain') {
  const { acquireViteProcessStop } = await import(new URL('serve/vite-process-stop.js', dist).href);
  acquireViteProcessStop({ write: () => undefined });
}
const { createViteModuleContext, createViteModuleSwap } = await import(new URL('serve/vite-module-swap.js', dist).href);
const swap = createViteModuleSwap(createViteModuleContext());
const alias = swap.config({ devServer: true }).resolve.alias[0];
swap.configResolved({ root: appRoot });
const importer = path.join(appRoot, 'src', 'main.ts');
const client = { environment: { name: 'client', config: { consumer: 'client' } }, resolve: async () => null };
const browser = {};
for (const specifier of specifiers) {
  const answer = await swap.resolvePluginId(client, specifier.replace(alias.find, alias.replacement), importer);
  const id = typeof answer === 'string' ? answer : answer?.id ?? null;
  const source = id === null ? null : await swap.loadPluginModule(id);
  browser[specifier] = { id, source };
}
const require = createRequire(importer);
const outcomes = [];
const failed = (specifier, via, error) => ({ specifier, via, result: error?.code ?? String(error), message: String(error?.message) });
for (const specifier of specifiers) {
  try { await import(specifier); outcomes.push({ specifier, via: 'import', result: 'loaded' }); }
  catch (error) { outcomes.push(failed(specifier, 'import', error)); }
  try { require(specifier); outcomes.push({ specifier, via: 'require', result: 'loaded' }); }
  catch (error) { outcomes.push(failed(specifier, 'require', error)); }
}
process.stdout.write(JSON.stringify({ node: process.version, browser, outcomes, loaded }));
`;

/**
 * The register maps an unserved `firebase/*` subpath to the same subpath of
 * `pyric`, which doesn't export it, so Node refuses it there and the real
 * SDK never resolves.
 */
function isUnmirroredUnderRegister(mode: 'plain' | 'register', outcome: NodeOutcome): boolean {
  const isNotExported = outcome.result === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  const isPyricPackage = /\/pyric\/package\.json/.test(outcome.message ?? '');
  return mode === 'register' && outcome.specifier.startsWith('firebase/') && isNotExported && isPyricPackage;
}

function runChild(mode: 'plain' | 'register'): ChildReport {
  const preload = mode === 'register' ? ['--import', REGISTER] : [];
  const args = [...preload, '--input-type=module', '-e', CHILD, DIST, CLI_ROOT, mode, JSON.stringify(UNSERVED)];
  const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: undefined, PYRIC_SANDBOX: undefined };
  if (mode === 'register') env.PYRIC_SANDBOX = 'local';
  const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', args, {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`the child exited ${result.status}:\n${result.stderr}`);
  return JSON.parse(result.stdout) as ChildReport;
}

describe.each(['plain', 'register'] as const)('the real SDK stop on this Node, %s', (mode) => {
  const report = runChild(mode);

  test('the swap gives the browser the stop for every unserved import', () => {
    const answers = Object.fromEntries(UNSERVED.map((specifier) => {
      const { id, source } = report.browser[specifier]!;
      const isStop = id !== null && id.startsWith('\0pyric-stop:') && (source ?? '').includes('PYRIC_REAL_SDK_STOPPED');
      return [specifier, isStop ? 'stop' : `${report.node}: ${JSON.stringify(id)}`];
    }));
    expect(answers).toEqual(Object.fromEntries(UNSERVED.map((specifier) => [specifier, 'stop'])));
  });

  test('every load in the process is served by pyric or stopped', () => {
    const unexpected = report.outcomes.filter((outcome) => {
      const isServedOrStopped = outcome.result === 'loaded' || outcome.result === 'PYRIC_REAL_SDK_STOPPED';
      return !isServedOrStopped && !isUnmirroredUnderRegister(mode, outcome);
    });
    expect(unexpected).toEqual([]);
  });

  test('no file of the real firebase or firebase-admin packages loads', () => {
    expect(report.loaded.filter((url) => REAL_SDK_FILE.test(url))).toEqual([]);
  });
});
