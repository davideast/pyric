import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const command = join(import.meta.dir, 'check-browser-boundaries.ts');
const directories: string[] = [];
const reportSchema = z.object({
  entry: z.string(),
  bytes: z.number(),
  maximumBytes: z.number(),
  modules: z.array(z.string()),
  issues: z.array(z.object({ rule: z.string(), message: z.string() })),
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-browser-boundary-')));
  directories.push(directory);
  return directory;
}

function fixture(source: string, path = 'entry.ts'): string {
  const directory = temporaryDirectory();
  const entry = join(directory, path);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, source);
  return entry;
}

function run(entry: string, maxBytes = '20000') {
  return spawnSync(process.execPath, [command, entry, maxBytes], { encoding: 'utf8', timeout: 10_000 });
}

test('browser boundary command measures an actual bundle and names its contributing input', () => {
  const entry = fixture(`export const label = '${'x'.repeat(10_000)}';`);

  const result = run(entry);
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(0);
  expect(report.entry).toBe(entry);
  expect(report.bytes).toBeGreaterThan(10_000);
  expect(report.modules).toEqual([entry]);
  expect(report.issues).toEqual([]);
});

test('browser boundary command rejects a sandbox engine that reaches the emitted bundle', () => {
  const sandboxEntry = fileURLToPath(import.meta.resolve('pyric/sandbox'));
  const entry = fixture(`export { initializeSandbox } from ${JSON.stringify(sandboxEntry)};`);

  const result = run(entry, '10000000');
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(1);
  expect(report.issues).toContainEqual({ rule: 'engine-import', message: expect.stringContaining('/sandbox/') });
});

test('browser boundary command enforces the declared emitted-byte budget', () => {
  const entry = fixture(`export const label = '${'x'.repeat(10_000)}';`);

  const result = run(entry, '1000');
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(1);
  expect(report.issues).toContainEqual({ rule: 'bundle-size', message: expect.stringContaining('1000 bytes') });
});

test('browser boundary command rejects code owned by a host even when it has no Node imports', () => {
  const entry = fixture("export const owner = 'host';", 'packages/cli/src/serve/hosted/entry.ts');

  const result = run(entry);
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(1);
  expect(report.issues).toContainEqual({ rule: 'host-import', message: entry });
});

test('browser boundary command applies engine ownership to TSX sources', () => {
  const entry = fixture("export const owner = 'engine';", 'packages/pyric/src/sandbox/entry.tsx');

  const result = run(entry);
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(1);
  expect(report.issues).toContainEqual({ rule: 'engine-import', message: entry });
});

test('browser boundary command permits the shared Firebase error and value codec leaves', () => {
  const appEntry = fileURLToPath(import.meta.resolve('pyric/app'));
  const codecEntry = fileURLToPath(import.meta.resolve('pyric/firestore/internal/value-codec'));
  const entry = fixture(`
    export { FirebaseError } from ${JSON.stringify(appEntry)};
    export { rehydrateDocValue } from ${JSON.stringify(codecEntry)};
  `);

  const result = run(entry);
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(0);
  expect(report.modules).toContain(codecEntry);
  expect(report.issues).toEqual([]);
});

test('browser boundary command refuses Node imports instead of shimming them', () => {
  const entry = fixture("export { readFileSync } from 'node:fs';");

  const result = run(entry);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Could not resolve "node:fs"');
  expect(result.stdout).toBe('');
});

test('browser boundary command refuses imports left outside the inspected bundle', () => {
  const entry = fixture("export { initializeSandbox } from 'https://example.invalid/pyric.js';");

  const result = run(entry);
  const report = reportSchema.parse(JSON.parse(result.stdout));

  expect(result.status).toBe(1);
  expect(report.issues).toContainEqual({ rule: 'unbundled-import', message: 'https://example.invalid/pyric.js' });
});

test.each(['0', '-1', 'Infinity', 'not-a-number'])('browser boundary command refuses the invalid budget %s', (budget) => {
  const entry = fixture('export const value = 1;');

  const result = run(entry, budget);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('The browser bundle budget must be a positive integer number of bytes.');
  expect(result.stdout).toBe('');
});

test('required CI checks every declared browser leaf after building workspace declarations', () => {
  const root = resolve(import.meta.dir, '../../..');
  const source = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
  const workflow = z.object({
    jobs: z.object({
      'build-packages': z.object({
        'continue-on-error': z.literal(false).optional(),
        steps: z.array(z.object({
          name: z.string().optional(),
          run: z.string().optional(),
          if: z.string().optional(),
          'continue-on-error': z.literal(false).optional(),
        })),
      }),
      required: z.object({ needs: z.array(z.string()) }),
    }),
  }).parse(Bun.YAML.parse(source));
  const steps = workflow.jobs['build-packages'].steps;
  const buildIndex = steps.findIndex((step) => step.name === 'Build packages (site omitted)');
  const testIndex = steps.findIndex((step) => step.name === 'Test browser boundary command');
  const checkIndex = steps.findIndex((step) => step.name === 'Check browser leaf boundaries');
  const step = steps[checkIndex];
  expect(workflow.jobs.required.needs).toContain('build-packages');
  expect(buildIndex).toBeGreaterThanOrEqual(0);
  expect(testIndex).toBeGreaterThan(buildIndex);
  expect(checkIndex).toBeGreaterThan(buildIndex);
  expect(step?.if).toBeUndefined();
  expect(step?.run).toBeDefined();
  const script = step?.run;
  const isMissingCommand = script === undefined;
  if (isMissingCommand) throw new Error('Required build has no browser boundary command');
  const reportDirectory = temporaryDirectory();

  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: reportDirectory }, encoding: 'utf8', timeout: 10_000,
  });

  expect(result.status).toBe(0);
  const profiles = [
    ['worker-client', 'packages/cli/src/serve/worker/client.ts', 98_304],
    ['hosted-socket', 'packages/cli/src/serve/worker/client/websocket-connection.ts', 16_384],
    ['value-codec', 'packages/pyric/src/firestore/internal/value-codec.ts', 24_576],
  ] as const;
  for (const [name, entry, maximumBytes] of profiles) {
    const reportPath = join(reportDirectory, `pyric-browser-${name}.json`);
    const report = reportSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    expect(report.entry).toBe(realpathSync(join(root, entry)));
    expect(report.maximumBytes).toBe(maximumBytes);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.bytes).toBeLessThanOrEqual(maximumBytes);
    expect(report.issues).toEqual([]);
  }
});
