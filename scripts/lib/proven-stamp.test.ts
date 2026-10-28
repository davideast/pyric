import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const stampScript = resolve(import.meta.dir, 'proven-stamp.mjs');
const VERSION = '0.1.0-alpha.9';
const NAMES = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui'];
const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function node(repo: string, ...args: string[]) {
  return spawnSync('node', [stampScript, ...args], { cwd: repo, encoding: 'utf8' });
}

const packages = (repo: string) => join(repo, 'dist/packages');
const tarball = (repo: string, name: string) => join(packages(repo), `${name}-${VERSION}.tgz`);

/** A checkout with one commit, and dist/packages (ignored) as pack-packages.sh leaves it. */
function checkout(): string {
  const repo = mkdtempSync(join(tmpdir(), 'pyric-proven-stamp-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  writeFileSync(join(repo, 'README.md'), 'first\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  mkdirSync(packages(repo), { recursive: true });
  return repo;
}

/** What pack-packages.sh does: write the tarballs and a manifest, then record the pack. */
function pack(repo: string, options: { clean?: boolean; names?: string[] } = {}): void {
  for (const name of options.names ?? NAMES) writeFileSync(tarball(repo, name), `${name} as packed`);
  writeFileSync(join(packages(repo), 'manifest.json'), JSON.stringify({ packages: [] }));
  const recorded = node(repo, 'record', packages(repo), repo, git(repo, 'rev-parse', 'HEAD'), String(options.clean ?? true));
  if (recorded.status !== 0) throw new Error(recorded.stderr);
}

const stamp = (repo: string, names = NAMES) => node(repo, 'write', packages(repo), VERSION, repo, ...names);
const verify = (repo: string, dir = packages(repo), version = VERSION, names = NAMES) => node(repo, 'verify', dir, version, repo, ...names);

describe('stamping a pack that passed the gates', () => {
  test('a pack still as written, on its own tree, is stamped and verifies', () => {
    const repo = checkout();
    pack(repo);
    expect(stamp(repo).status).toBe(0);
    const verified = verify(repo);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('are the ones proven on');
  });

  test('a tarball something swapped during the gates is not stamped', () => {
    const repo = checkout();
    pack(repo);
    writeFileSync(tarball(repo, 'pyric-cli'), 'a concurrent repack');
    const stamped = stamp(repo);
    expect(stamped.status).toBe(1);
    expect(stamped.stderr).toContain(`pyric-cli-${VERSION}.tgz is not the file the pack names`);
  });

  test('a pack from an earlier commit, or from a dirty tree, is not stamped', () => {
    const moved = checkout();
    pack(moved);
    writeFileSync(join(moved, 'README.md'), 'second\n');
    git(moved, 'commit', '-q', '-am', 'second');
    expect(stamp(moved).stderr).toContain('were packed from commit');

    const dirty = checkout();
    pack(dirty, { clean: false });
    expect(stamp(dirty).stderr).toContain('when the tarballs were packed');
  });

  test('a pack that wrote fewer tarballs than the publish uploads is not stamped', () => {
    const repo = checkout();
    pack(repo, { names: NAMES.slice(0, 4) });
    expect(stamp(repo).status).toBe(1);
  });

  test('a directory no pack recorded is not stamped', () => {
    const repo = checkout();
    for (const name of NAMES) writeFileSync(tarball(repo, name), name);
    expect(stamp(repo).stderr).toContain('no manifest.json');
  });
});

describe('verifying the stamp before an upload', () => {
  function stamped(): string {
    const repo = checkout();
    pack(repo);
    expect(stamp(repo).status).toBe(0);
    return repo;
  }

  test('tarballs from an earlier commit at the same version are refused', () => {
    const repo = stamped();
    writeFileSync(join(repo, 'README.md'), 'second\n');
    git(repo, 'commit', '-q', '-am', 'second');
    expect(verify(repo).stderr).toContain('were packed from commit');
  });

  test('a tarball whose bytes changed after the stamp is refused', () => {
    const repo = stamped();
    writeFileSync(tarball(repo, 'pyric'), 'evil');
    expect(verify(repo).stderr).toContain(`pyric-${VERSION}.tgz is not the file the stamp names`);
  });

  test('anything but exactly the five uploaded tarballs is refused', () => {
    const repo = stamped();
    unlinkSync(tarball(repo, 'pyric-ui'));
    expect(verify(repo).stderr).toContain(`pyric-ui-${VERSION}.tgz is missing`);
    expect(verify(stamped(), undefined, VERSION, [...NAMES, 'pyric-extra']).status).toBe(1);
    expect(verify(stamped(), undefined, VERSION, NAMES.slice(0, 4)).status).toBe(1);
  });

  test('no stamp, a malformed stamp, or another version is refused', () => {
    const none = checkout();
    pack(none);
    expect(verify(none).stderr).toContain('no gate run proved these tarballs');
    const malformed = stamped();
    writeFileSync(join(packages(malformed), 'proven.json'), '{');
    expect(verify(malformed).stderr).toContain('not valid JSON');
    expect(verify(stamped(), undefined, '0.1.0-alpha.10').status).toBe(1);
  });

  test('an untracked file counts as a dirty tree, whatever status.showUntrackedFiles says', () => {
    const repo = stamped();
    writeFileSync(join(repo, 'injected.ts'), 'x');
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    expect(verify(repo).stderr).toContain('uncommitted or untracked changes now');
  });
});

describe('checking downloaded tarballs against the pack record', () => {
  /** Runs `check` with GITHUB_SHA as given, never the one a CI runner sets for this test run. */
  const check = (repo: string, githubSha?: string) => {
    const env = { ...process.env };
    delete env.GITHUB_SHA;
    if (githubSha !== undefined) env.GITHUB_SHA = githubSha;
    return spawnSync('node', [stampScript, 'check', packages(repo), repo], { cwd: repo, encoding: 'utf8', env });
  };

  test('the tarballs the pack wrote pass on their own commit, even in a dirty tree', () => {
    const repo = checkout();
    pack(repo);
    writeFileSync(join(repo, 'downloaded.txt'), 'a job writes files');
    const checked = check(repo);
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('are the ones packed from');
  });

  test('tarballs packed from another commit are refused, by HEAD or by GITHUB_SHA', () => {
    const repo = checkout();
    pack(repo);
    const packedFrom = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'README.md'), 'second\n');
    git(repo, 'commit', '-q', '-am', 'second');
    const byHead = check(repo);
    expect(byHead.status).toBe(1);
    expect(byHead.stderr).toContain(`packed from commit ${packedFrom}`);
    // GITHUB_SHA, when set, names the commit and wins over HEAD.
    expect(check(repo, packedFrom).status).toBe(0);
    const other = check(repo, 'f'.repeat(40));
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(`this job checked out ${'f'.repeat(40)}`);
  });

  test('a tarball whose bytes changed after the pack is refused', () => {
    const repo = checkout();
    pack(repo);
    writeFileSync(tarball(repo, 'pyric-cli'), 'another build');
    const checked = check(repo);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain(`pyric-cli-${VERSION}.tgz is not the file the pack record names`);
    expect(checked.stderr).not.toContain('PYRIC_PUBLISH_SKIP_GATES');
  });

  test('a missing or an extra tarball is refused', () => {
    const missing = checkout();
    pack(missing);
    unlinkSync(tarball(missing, 'pyric-ui'));
    expect(check(missing).status).toBe(1);

    const extra = checkout();
    pack(extra);
    writeFileSync(tarball(extra, 'pyric-extra'), 'not packed');
    expect(check(extra).stderr).toContain('not exactly');
  });

  test('no manifest, no pack record, or no tarballs is refused', () => {
    const none = checkout();
    expect(check(none).stderr).toContain('no manifest.json');

    const unrecorded = checkout();
    writeFileSync(join(packages(unrecorded), 'manifest.json'), JSON.stringify({ packages: [] }));
    expect(check(unrecorded).stderr).toContain('has no pack record');

    const empty = checkout();
    pack(empty, { names: [] });
    expect(check(empty).stderr).toContain('holds no tarballs');
  });
});
