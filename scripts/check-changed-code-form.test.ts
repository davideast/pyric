import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const scriptsDirectory = resolve('scripts');
const checker = join(scriptsDirectory, 'check-changed-code-form.ts');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-code-form-'));
  directories.push(directory);
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Code form fixture', '-c', 'user.email=fixture@example.test', ...args,
  ], { cwd: directory, encoding: 'utf8' }).trim();
  const write = (path: string, source: string) => {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  };
  git('init', '--quiet');
  write('.gitignore', 'ignored.ts\n');
  git('add', '.gitignore');
  git('commit', '--quiet', '-m', 'Fixture baseline');
  const run = (...args: string[]) => spawnSync(process.execPath, [checker, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
  });
  return { directory, git, write, run };
}

test('changed-code command reports the exact tracked and untracked TypeScript changes and their source identity', () => {
  const repo = repository();
  const before = 'const ready = false;\n';
  const after = 'const ready = true;\n';
  repo.write('staged.ts', before);
  repo.write('unstaged.ts', before);
  repo.write('unchanged.ts', before);
  repo.write('deleted.ts', before);
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'Tracked source');
  const base = repo.git('rev-parse', 'HEAD');
  repo.write('staged.ts', after);
  repo.git('add', 'staged.ts');
  repo.write('unstaged.ts', after);
  repo.git('rm', '--quiet', 'deleted.ts');
  for (const path of ['new file.tsx', 'nested/new\nline.mts', 'new.cts', 'types.d.ts']) {
    repo.write(path, after);
  }
  repo.write('ignored.ts', 'if (count > 0) run();');
  repo.write('notes.md', 'if (count > 0) run();');

  const result = repo.run(base);
  const report: unknown = JSON.parse(result.stdout);
  const sourceDigest = createHash('sha256').update(after).digest('hex');
  const beforeDigest = createHash('sha256').update(before).digest('hex');

  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(report).toEqual({
    schema: 'pyric.code-form-report.v1', baseRevision: base,
    files: [
      { path: 'nested/new\nline.mts', sourceDigest, baseDigest: null, issues: [], excluded: [] },
      { path: 'new file.tsx', sourceDigest, baseDigest: null, issues: [], excluded: [] },
      { path: 'new.cts', sourceDigest, baseDigest: null, issues: [], excluded: [] },
      { path: 'staged.ts', sourceDigest, baseDigest: beforeDigest, issues: [], excluded: [] },
      { path: 'types.d.ts', sourceDigest, baseDigest: null, issues: [], excluded: [] },
      { path: 'unstaged.ts', sourceDigest, baseDigest: beforeDigest, issues: [], excluded: [] },
    ],
  });
});

test('changed-code command fails for new violations while exposing unchanged legacy exclusions', () => {
  const repo = repository();
  const legacy = 'function legacy() { if (count > 0) run(); }';
  repo.write('edited.ts', legacy);
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'Legacy source');
  const base = repo.git('rev-parse', 'HEAD');
  repo.write('edited.ts', `${legacy}\nfunction added() { if (count > 0) run(); }`);

  const result = repo.run(base);
  const report: unknown = JSON.parse(result.stdout);

  expect(result.status).toBe(1);
  expect(report).toMatchObject({
    files: [{
      path: 'edited.ts',
      issues: [{ rule: 'named-condition', line: 2, column: 24 }],
      excluded: [{ startLine: 1, endLine: 1, reason: 'unchanged-top-level-statement' }],
    }],
  });
});

test('changed-code command fails for malformed TypeScript', () => {
  const repo = repository();
  repo.write('broken.ts', 'const ready = ;');

  const result = repo.run('HEAD');
  const report: unknown = JSON.parse(result.stdout);

  expect(result.status).toBe(1);
  expect(report).toMatchObject({
    files: [{ path: 'broken.ts', issues: [{ rule: 'syntax', line: 1, column: 15 }], excluded: [] }],
  });
});

test('changed-code command refuses a missing or unresolved baseline', () => {
  const repo = repository();
  const missing = repo.run();
  const unresolved = repo.run('not-a-commit');

  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('Usage: bun scripts/check-changed-code-form.ts <base-revision>');
  expect(missing.stdout).toBe('');
  expect(unresolved.status).toBe(1);
  expect(unresolved.stderr).toContain('Needed a single revision');
  expect(unresolved.stdout).toBe('');
});

test('changed-code command requires named decisions to have boolean types', () => {
  const repo = repository();
  repo.write('decision.ts', 'const count = 1; if (count) {}');

  const rejected = repo.run('HEAD');
  const report: unknown = JSON.parse(rejected.stdout);

  expect(rejected.status).toBe(1);
  expect(report).toMatchObject({
    files: [{ path: 'decision.ts', issues: [{ rule: 'boolean-condition' }] }],
  });

  repo.write('decision.ts', 'const hasItems = true; if (hasItems) {}');
  expect(repo.run('HEAD').status).toBe(0);
});

test('changed-code command resolves a decision type from an unchanged imported module', () => {
  const repo = repository();
  repo.write('config.ts', 'export const enabled: boolean = true;');
  repo.git('add', '.');
  repo.git('commit', '--quiet', '-m', 'Typed configuration');
  repo.write('decision.ts', "import { enabled } from './config.js'; if (enabled) {}");

  const result = repo.run('HEAD');
  const report: unknown = JSON.parse(result.stdout);

  expect(result.status).toBe(0);
  expect(report).toMatchObject({ files: [{ path: 'decision.ts', issues: [] }] });

  repo.write('config.ts', 'export const enabled = 1;');
  const rejected = repo.run('HEAD');
  const rejectedReport: unknown = JSON.parse(rejected.stdout);
  expect(rejected.status).toBe(1);
  expect(rejectedReport).toMatchObject({
    files: [
      { path: 'config.ts', issues: [] },
      { path: 'decision.ts', issues: [{ rule: 'boolean-condition' }] },
    ],
  });
});

test.each([
  { name: 'an unresolved import', source: "import { enabled } from './missing.js'; if (enabled) {}" },
  { name: 'a nullable boolean', source: 'function choose(enabled: boolean | undefined) { if (enabled) {} }' },
  { name: 'an unknown value', source: 'function choose(enabled: unknown) { if (enabled) {} }' },
  { name: 'an implicit any', source: 'function choose(enabled) { if (enabled) {} }' },
])('changed-code command cannot certify $name as a boolean decision', ({ source }) => {
  const repo = repository();
  repo.write('decision.ts', source);

  const result = repo.run('HEAD');
  const report: unknown = JSON.parse(result.stdout);

  expect(result.status).toBe(1);
  expect(report).toMatchObject({
    files: [{ path: 'decision.ts', issues: [{ rule: 'boolean-condition' }] }],
  });
});

test('changed-code command accepts constrained and narrowed boolean decisions', () => {
  const repo = repository();
  repo.write('decision.ts', `
    export function constrained<T extends boolean>(enabled: T) { if (enabled) {} }
    export function narrowed(enabled: unknown) {
      const isBoolean = typeof enabled === 'boolean';
      if (isBoolean) { if (enabled) {} }
    }
  `);

  const result = repo.run('HEAD');
  const report: unknown = JSON.parse(result.stdout);

  expect(result.status).toBe(0);
  expect(report).toMatchObject({ files: [{ path: 'decision.ts', issues: [] }] });
});

test('required build runs the code-form command and propagates its failure', () => {
  const workflowSource = readFileSync(resolve('.github/workflows/build.yml'), 'utf8');
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
  }).parse(Bun.YAML.parse(workflowSource));
  const steps = workflow.jobs['build-packages'].steps;
  const buildIndex = steps.findIndex((entry) => entry.name === 'Build packages (site omitted)');
  const checkIndex = steps.findIndex((entry) => entry.name === 'Check changed TypeScript code form');
  const step = steps[checkIndex];
  expect(workflow.jobs.required.needs).toContain('build-packages');
  expect(buildIndex).toBeGreaterThanOrEqual(0);
  expect(checkIndex).toBeGreaterThan(buildIndex);
  expect(step?.if).toBeUndefined();
  expect(step?.run).toBeDefined();
  const command = step?.run;
  const isMissingCommand = command === undefined;
  if (isMissingCommand) throw new Error('Required build has no code-form command');

  const repo = repository();
  symlinkSync(scriptsDirectory, join(repo.directory, 'scripts'), 'dir');
  const env = { ...process.env, CODE_FORM_BASE: 'HEAD', RUNNER_TEMP: repo.directory };
  const runStep = () => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
    cwd: repo.directory, env, encoding: 'utf8', timeout: 10_000,
  });
  repo.write('source.ts', 'const isReady = true; if (isReady) run();');
  expect(runStep().status).toBe(0);

  repo.write('source.ts', 'if (count > 0) run();');
  expect(runStep().status).toBe(1);
  const report: unknown = JSON.parse(readFileSync(join(repo.directory, 'pyric-code-form.json'), 'utf8'));
  expect(report).toMatchObject({
    files: [{ path: 'source.ts', issues: [{ rule: 'named-condition', line: 1, column: 5 }] }],
  });
});
