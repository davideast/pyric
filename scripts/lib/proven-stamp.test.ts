import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const stampScript = resolve(import.meta.dir, 'proven-stamp.mjs');
const VERSION = '0.1.0-alpha.9';
const TARBALLS = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui'];
const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

/** A checkout with one commit and the five tarballs packed into dist/packages, which git ignores. */
function packedCheckout(): string {
  const repo = mkdtempSync(join(tmpdir(), 'pyric-proven-stamp-'));
  repos.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  writeFileSync(join(repo, 'README.md'), 'first\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  mkdirSync(join(repo, 'dist/packages'), { recursive: true });
  for (const name of TARBALLS) writeFileSync(join(repo, `dist/packages/${name}-${VERSION}.tgz`), `${name} bytes`);
  return repo;
}

function stamp(repo: string, action: 'write' | 'verify', version = VERSION) {
  return spawnSync('node', [stampScript, action, join(repo, 'dist/packages'), version, repo], { cwd: repo, encoding: 'utf8' });
}

describe('the stamp that lets a gate-skipping rerun upload the proven tarballs', () => {
  test('tarballs stamped on a clean tree verify on that tree', () => {
    const repo = packedCheckout();
    expect(stamp(repo, 'write').status).toBe(0);
    const verified = stamp(repo, 'verify');
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('proven');
  });

  test('tarballs from an earlier commit at the same version are refused', () => {
    const repo = packedCheckout();
    expect(stamp(repo, 'write').status).toBe(0);
    writeFileSync(join(repo, 'README.md'), 'second\n');
    git(repo, 'commit', '-q', '-am', 'second');
    const verified = stamp(repo, 'verify');
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('were proven on commit');
  });

  test('a tarball whose bytes changed after the gates passed is refused', () => {
    const repo = packedCheckout();
    expect(stamp(repo, 'write').status).toBe(0);
    writeFileSync(join(repo, `dist/packages/pyric-cli-${VERSION}.tgz`), 'a later, unchecked pack');
    const verified = stamp(repo, 'verify');
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain(`pyric-cli-${VERSION}.tgz`);
  });

  test('tarballs no gate run stamped, such as a failed build\'s leftovers, are refused', () => {
    const verified = stamp(packedCheckout(), 'verify');
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('no proven.json');
  });

  test('a dirty tree, at stamping or at upload, is refused', () => {
    const dirtyAtStamp = packedCheckout();
    writeFileSync(join(dirtyAtStamp, 'README.md'), 'uncommitted\n');
    expect(stamp(dirtyAtStamp, 'write').status).toBe(0);
    expect(stamp(dirtyAtStamp, 'verify').stderr).toContain('uncommitted changes');

    const dirtyAtUpload = packedCheckout();
    expect(stamp(dirtyAtUpload, 'write').status).toBe(0);
    writeFileSync(join(dirtyAtUpload, 'README.md'), 'uncommitted\n');
    const verified = stamp(dirtyAtUpload, 'verify');
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('uncommitted changes');
  });

  test('a different version is refused', () => {
    const repo = packedCheckout();
    expect(stamp(repo, 'write').status).toBe(0);
    expect(stamp(repo, 'verify', '0.1.0-alpha.10').status).toBe(1);
  });
});
