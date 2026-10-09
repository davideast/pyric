/**
 * Vite restarts a dev server by creating the replacement, which re-evaluates
 * the config file and builds a new `pyric()` instance, before it closes the old
 * server. These tests run real Vite on Node from a config file and restart it.
 * Build the CLI first: the config imports `@pyric/cli/vite` from `dist`.
 * PYRIC_TEST_NODE optionally selects the Node executable.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmViteWorkerBundle } from './vite-plugin-harness.js';

beforeAll(async () => { await warmViteWorkerBundle(); }, 180_000);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeProject(pluginOptions: string): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-restart-')));
  directories.push(parent);
  const root = join(parent, 'app');
  mkdirSync(root);
  symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  writeFileSync(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-app' } }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body></body></html>');
  writeFileSync(join(root, 'vite.config.mjs'), [
    "import { pyric } from '@pyric/cli/vite';",
    `export default { plugins: [pyric(${pluginOptions})] };`,
    '',
  ].join('\n'));
  return root;
}

interface RestartPhase {
  errors: string[];
  init: number;
  replacedInstance: boolean;
  read: { ok: boolean; data?: unknown } | null;
}

interface RestartReport {
  failure?: string;
  closeFailure?: string;
  write?: { ok: boolean };
  afterRestart?: RestartPhase;
  afterConfigEdit?: RestartPhase;
  others?: Array<{ sameInstance: boolean; errors: string[]; read: { ok: boolean; data?: unknown } | null }>;
}

function runRestartHost(roots: string[], hosted: boolean): RestartReport {
  const script = new URL('./fixtures/vite-restart-host.mjs', import.meta.url).pathname;
  const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [script, ...roots], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, PYRIC_RESTART_HOSTED: hosted ? '1' : '0' },
  });
  const exitedCleanly = result.status === 0;
  if (!exitedCleanly) throw new Error(`Vite restart host failed (${result.status}): ${result.stderr}`);
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as RestartReport;
}

function readValue(read: RestartPhase['read']): unknown {
  return (read?.data as { value?: unknown } | undefined)?.value;
}

test('a hosted Vite server restarts, from restart() and from a config edit, onto the same stored data', () => {
  const app = writeProject('{ hosted: true }');
  const other = writeProject('{ hosted: true }');
  const report = runRestartHost([app, other], true);

  expect(report.failure).toBeUndefined();
  expect(report.closeFailure).toBeUndefined();
  expect(report.write?.ok).toBe(true);

  // The replacement claimed the hosted state, so the old generation released it.
  expect(report.afterRestart?.errors).toEqual([]);
  expect(report.afterRestart?.replacedInstance).toBe(true);
  expect(report.afterRestart?.init).toBe(200);
  expect(report.afterRestart?.read?.ok).toBe(true);
  expect(readValue(report.afterRestart?.read ?? null)).toBe('before restart');

  expect(report.afterConfigEdit?.errors).toEqual([]);
  expect(report.afterConfigEdit?.replacedInstance).toBe(true);
  expect(report.afterConfigEdit?.init).toBe(200);
  expect(readValue(report.afterConfigEdit?.read ?? null)).toBe('before restart');

  // Another project in the same process keeps its own generation and data.
  expect(report.others?.[0]?.sameInstance).toBe(true);
  expect(report.others?.[0]?.errors).toEqual([]);
  expect(readValue(report.others?.[0]?.read ?? null)).toBe(`kept in ${other}`);
}, 120_000);

test('a Vite server persisting browser state restarts from restart() and from a config edit', () => {
  const app = writeProject('{ persist: true, bridge: { disableAuditLog: true } }');
  const report = runRestartHost([app], false);

  expect(report.failure).toBeUndefined();
  expect(report.closeFailure).toBeUndefined();
  expect(report.afterRestart?.errors).toEqual([]);
  expect(report.afterRestart?.replacedInstance).toBe(true);
  expect(report.afterRestart?.init).toBe(200);
  expect(report.afterConfigEdit?.errors).toEqual([]);
  expect(report.afterConfigEdit?.replacedInstance).toBe(true);
  expect(report.afterConfigEdit?.init).toBe(200);
}, 120_000);
