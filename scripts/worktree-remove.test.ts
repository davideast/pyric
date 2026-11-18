import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT_PATH = resolve(import.meta.dir, 'worktree-remove.sh');
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createRepoWithWorktree(): { root: string; repoDir: string; wtDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pyric-wt-remove-ut-'));
  tempRoots.push(root);
  const repoDir = join(root, 'repo');
  const wtDir = join(root, 'wt', 'slice-1');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['-C', repoDir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execFileSync('git', ['-C', repoDir, 'add', 'README.md']);
  execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'init']);
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-q', '-b', 'feat/slice-1', wtDir, 'main']);
  return { root, repoDir, wtDir };
}

describe('scripts/worktree-remove.sh', () => {
  it('refuses canonical main checkouts and .trash paths without deleting files', () => {
    const { root, repoDir } = createRepoWithWorktree();
    const refusedMain = spawnSync('bash', [SCRIPT_PATH, repoDir], { encoding: 'utf8' });
    expect(refusedMain.status).not.toBe(0);
    expect(refusedMain.stderr).toContain('refusing to remove main git repository checkout');
    expect(existsSync(join(repoDir, 'README.md'))).toBe(true);

    const trashDir = join(root, '.trash-old-wt');
    mkdirSync(trashDir);
    const refusedTrash = spawnSync('bash', [SCRIPT_PATH, trashDir], { encoding: 'utf8' });
    expect(refusedTrash.status).not.toBe(0);
    expect(refusedTrash.stderr).toContain('refusing .trash path');
    expect(existsSync(trashDir)).toBe(true);
  }, 30_000);

  it('refuses dirty worktrees unless --force is passed, then unlinks and prunes cleanly', () => {
    const { repoDir, wtDir } = createRepoWithWorktree();
    mkdirSync(join(wtDir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(wtDir, 'packages', 'sub', 'dist'), { recursive: true });
    writeFileSync(join(wtDir, 'untracked.txt'), 'dirty\n');

    const refusedDirty = spawnSync('bash', [SCRIPT_PATH, wtDir], { encoding: 'utf8' });
    expect(refusedDirty.status).not.toBe(0);
    expect(refusedDirty.stderr).toContain('uncommitted or untracked changes');
    expect(existsSync(wtDir)).toBe(true);

    const refusedMainBranch = spawnSync(
      'bash',
      [SCRIPT_PATH, '--force', '--delete-branch', 'main', wtDir],
      { encoding: 'utf8' },
    );
    expect(refusedMainBranch.status).not.toBe(0);
    expect(refusedMainBranch.stderr).toContain('refusing to delete protected branch');
    expect(existsSync(wtDir)).toBe(true);

    // Invoking from inside wtDir itself must succeed cleanly without getcwd() rc=128 errors.
    const forced = spawnSync(
      'bash',
      [SCRIPT_PATH, '--force', '--delete-branch', 'feat/slice-1', wtDir],
      { cwd: wtDir, encoding: 'utf8' },
    );
    expect(forced.status).toBe(0);
    expect(existsSync(wtDir)).toBe(false);

    const listed = execFileSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(listed).not.toContain(wtDir);
    const branches = execFileSync('git', ['-C', repoDir, 'branch', '--list', 'feat/slice-1'], {
      encoding: 'utf8',
    }).trim();
    expect(branches).toBe('');
  }, 30_000);
});
