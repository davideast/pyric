import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const script = resolve(root, 'scripts/ci/conformance-coupling-gate.sh');

// Hermetic git: no user config, no hooks, no signing, no templates.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'CI',
  GIT_AUTHOR_EMAIL: 'ci@example.com',
  GIT_COMMITTER_NAME: 'CI',
  GIT_COMMITTER_EMAIL: 'ci@example.com',
};

type GateEnv = Record<string, string | undefined>;

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
}

function write(cwd: string, relPath: string, contents: string): void {
  const abs = join(cwd, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * One seed file per ENGINE_PATHS entry. The gate refuses to run when a
 * configured engine path has vanished (a rename must not silently retire it),
 * so every entry has to exist in a synthetic workspace too — which also keeps
 * this list honest against the script's.
 */
const ENGINE_SEED_FILES = [
  'packages/pyric/src/rules/evaluate.ts',
  'packages/pyric/src/firestore/sandbox/local-state.ts',
  'packages/pyric/src/database/sandbox/read.ts',
  'packages/pyric/src/database/sandbox-controls.ts',
  'packages/pyric/src/storage/sandbox/rules.ts',
  'packages/pyric/src/storage/enforce.ts',
  'packages/pyric/src/sandbox/session.ts',
];

/**
 * A synthetic workspace whose base commit already carries one file under every
 * category the gate reasons about, so a test's diff contains exactly what the
 * test writes.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coupling-gate-'));
  scratch.push(dir);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  write(dir, 'README.md', 'base\n');
  for (const file of ENGINE_SEED_FILES) write(dir, file, 'export const v = 0;\n');
  write(dir, 'packages/conformance/matrix.json', '{"rows":0}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  git(dir, 'checkout', '--quiet', '-b', 'feature');
  return dir;
}

function commit(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', message);
}

/**
 * Runs the gate against a synthetic repo. GITHUB_ACTIONS / GITHUB_STEP_SUMMARY
 * are stripped unless a test opts in: both change the gate's behavior, and a
 * real CI run of this suite would otherwise leak them in via process.env.
 */
function runGate(cwd: string, overrides: GateEnv = {}): { status: number; output: string } {
  const env: GateEnv = { ...gitEnv };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_ACTIONS;
  Object.assign(env, { BASE_REF: 'main' }, overrides);
  const result = spawnSync('bash', [script], { cwd, encoding: 'utf8', env });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('conformance coupling gate', () => {
  test('a diff with no engine change passes silently', () => {
    const repo = makeRepo();
    write(repo, 'README.md', 'docs edit\n');
    write(repo, 'packages/cli/src/thing.ts', 'export const v = 1;\n');
    commit(repo, 'docs: unrelated edit');

    const { status, output } = runGate(repo);
    expect(status).toBe(0);
    expect(output.trim()).toBe('');
  });

  test('an engine-only change fails and names the offending files', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    commit(repo, 'fix(rules): tighten evaluation');

    const { status, output } = runGate(repo);
    expect(status).toBe(1);
    expect(output).toContain('packages/pyric/src/rules/evaluate.ts');
    expect(output).toContain('compat:conformance');
    expect(output).toContain('compat:rules-score');
    expect(output).toContain('Conformance-Exempt:');
  });

  test('every engine trigger path is covered, including the single-file entries', () => {
    for (const file of [
      'packages/pyric/src/rules/evaluate.ts',
      'packages/pyric/src/firestore/sandbox/local-state.ts',
      'packages/pyric/src/database/sandbox/read.ts',
      'packages/pyric/src/database/sandbox-controls.ts',
      'packages/pyric/src/storage/sandbox/rules.ts',
      'packages/pyric/src/storage/enforce.ts',
      'packages/pyric/src/sandbox/session.ts',
    ]) {
      const repo = makeRepo();
      write(repo, file, 'export const v = 1;\n');
      commit(repo, 'feat: engine edit');

      const { status, output } = runGate(repo);
      expect(status).toBe(1);
      expect(output).toContain(file);
    }
  });

  test('an engine change paired with conformance evidence passes', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    write(repo, 'packages/conformance/matrix.json', '{"rows":1}\n');
    commit(repo, 'fix(rules): tighten evaluation and regenerate evidence');

    const { status, output } = runGate(repo);
    expect(status).toBe(0);
    expect(output.trim()).toBe('');
  });

  test('an engine-only change with a Conformance-Exempt trailer passes with a notice', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(
      repo,
      'commit',
      '--quiet',
      '-m',
      'refactor(rules): rename internals',
      '-m',
      'Conformance-Exempt: pure rename, no observable behavior change'
    );

    const { status, output } = runGate(repo);
    expect(status).toBe(0);
    expect(output).toContain('EXEMPT');
    expect(output).toContain('pure rename, no observable behavior change');
    expect(output).toContain('packages/pyric/src/rules/evaluate.ts');
  });

  test('the trailer counts when it rides on any commit in the range', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/sandbox/session.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'chore: waive', '-m', 'Conformance-Exempt: infra only');
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 2;\n');
    commit(repo, 'refactor(rules): follow-up');

    const { status, output } = runGate(repo);
    expect(status).toBe(0);
    expect(output).toContain('EXEMPT');
  });

  test('a Conformance-Exempt trailer with an empty reason still fails', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'refactor(rules): rename internals', '-m', 'Conformance-Exempt:   ');

    const { status, output } = runGate(repo);
    expect(status).toBe(1);
    expect(output).toContain('packages/pyric/src/rules/evaluate.ts');
  });

  test('the notice is appended to GITHUB_STEP_SUMMARY when the environment sets it', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'refactor(rules): rename', '-m', 'Conformance-Exempt: rename only');

    const summaryPath = join(repo, 'step-summary.md');
    const { status } = runGate(repo, { GITHUB_STEP_SUMMARY: summaryPath });
    expect(status).toBe(0);
    expect(readFileSync(summaryPath, 'utf8')).toContain('rename only');
  });

  // A body line that merely LOOKS like a trailer is prose: quoted review notes,
  // pasted policy text, a revert that carries the original body forward. Only
  // git's own trailer block may waive the gate.
  test('a body that only quotes the trailer token mid-message does not waive the gate', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(
      repo,
      'commit',
      '--quiet',
      '-m',
      'refactor(rules): rename internals',
      '-m',
      'A reviewer might paste a note like:\nConformance-Exempt: totally fine, trust me\nand that prose must never waive this gate.'
    );

    const { status, output } = runGate(repo);
    expect(status).toBe(1);
    expect(output).toContain('FAILED');
    expect(output).toContain('packages/pyric/src/rules/evaluate.ts');
    expect(output).not.toContain('EXEMPT');
  });

  test('a genuine trailer still waives even when the body also quotes the token in prose', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(
      repo,
      'commit',
      '--quiet',
      '-m',
      'refactor(rules): rename internals',
      '-m',
      'The docs say to write "Conformance-Exempt: <reason>" as a trailer.',
      '-m',
      'Conformance-Exempt: pure rename, no observable behavior change'
    );

    const { status, output } = runGate(repo);
    expect(status).toBe(0);
    expect(output).toContain('EXEMPT');
    expect(output).toContain('pure rename, no observable behavior change');
  });

  // Default `diff --name-only` C-quotes non-ASCII paths
  // ("packages/pyric/src/rules/\303\251valuate.ts"), which matches no prefix
  // and would let the file through as if it were not an engine file at all.
  test('a non-ASCII engine path is still recognized (no C-quoting bypass)', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/évaluate.ts', 'export const v = 1;\n');
    commit(repo, 'feat(rules): add an accented module');

    const { status, output } = runGate(repo);
    expect(status).toBe(1);
    expect(output).toContain('évaluate.ts');
    expect(output).not.toContain('\\303\\251');
  });

  // A rename of any engine directory would otherwise retire the gate in
  // silence: nothing matches, so every later engine change passes.
  test.each([
    ['packages/pyric/src/sandbox/', 'packages/pyric/src/sandbox'],
    ['packages/pyric/src/storage/enforce.ts', 'packages/pyric/src/storage/enforce.ts'],
  ])('a vanished ENGINE_PATHS entry (%s) fails the gate rather than disabling it', (entry, target) => {
    const repo = makeRepo();
    rmSync(join(repo, target), { recursive: true, force: true });
    write(repo, 'README.md', 'unrelated edit\n');
    commit(repo, 'chore: move the engine tree');

    const { status, output } = runGate(repo);
    expect(status).toBe(1);
    expect(output).toContain(`ENGINE_PATHS entry '${entry}' no longer exists`);
    expect(output).toContain('update the gate');
  });

  test('every ENGINE_PATHS entry in the script is seeded by this suite', () => {
    const source = readFileSync(script, 'utf8');
    const block = source.slice(source.indexOf('ENGINE_PATHS=('), source.indexOf(')', source.indexOf('ENGINE_PATHS=(')));
    const configured = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(configured.length).toBeGreaterThan(0);
    for (const entry of configured) {
      expect(ENGINE_SEED_FILES.some((file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))).toBe(true);
    }
  });

  // An unreachable base in CI means a broken checkout, not a clean branch.
  test('an unresolvable merge base fails closed under GITHUB_ACTIONS', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    commit(repo, 'fix(rules): tighten evaluation');

    const { status, output } = runGate(repo, { BASE_REF: 'origin/nonexistent', GITHUB_ACTIONS: 'true' });
    expect(status).toBe(1);
    expect(output).toContain('UNRESOLVABLE BASE');
    expect(output).toContain('origin/nonexistent');
    expect(output).toContain('fetch-depth: 0');
  });

  test('an unresolvable merge base only warns on a local run', () => {
    const repo = makeRepo();
    write(repo, 'packages/pyric/src/rules/evaluate.ts', 'export const v = 1;\n');
    commit(repo, 'fix(rules): tighten evaluation');

    const { status, output } = runGate(repo, { BASE_REF: 'origin/nonexistent' });
    expect(status).toBe(0);
    expect(output).toContain('no merge base');
    expect(output).toContain('nothing to compare');
  });

  test('the gate is wired into the conformance-gates CI job', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
    const start = workflow.indexOf('\n  conformance-gates:');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = workflow.slice(start + 1);
    const end = rest.search(/\n  [a-z-]+:/);
    const job = end < 0 ? rest : rest.slice(0, end);
    expect(job).toContain('bash scripts/ci/conformance-coupling-gate.sh');
    // merge-base against the PR base needs real history in the checkout.
    expect(job).toContain('fetch-depth: 0');
  });
});
