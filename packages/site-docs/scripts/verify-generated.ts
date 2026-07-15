import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteRoot, '..', '..');
const contentRoot = join(siteRoot, 'src', 'content', 'docs');
const distRoot = join(siteRoot, 'dist');

function run(...args: string[]): void {
  execFileSync(args[0]!, args.slice(1), { cwd: siteRoot, stdio: 'inherit' });
}

function worktreeFingerprint(): string {
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot }));
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot },
  ).toString('utf8').split('\0').filter(Boolean).sort();
  for (const path of untracked) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(repoRoot, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

function outputFingerprint(): string {
  const hash = createHash('sha256');
  for (const root of [contentRoot, distRoot]) {
    for (const path of filesUnder(root)) {
      hash.update(relative(siteRoot, path));
      hash.update('\0');
      hash.update(readFileSync(path));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function buildAndVerify(): string {
  run('bun', 'run', 'build');
  run('bun', 'scripts/verify-dist.ts');
  return outputFingerprint();
}

const worktreeBefore = worktreeFingerprint();
rmSync(distRoot, { recursive: true, force: true });
const first = buildAndVerify();
rmSync(distRoot, { recursive: true, force: true });
const second = buildAndVerify();

if (first !== second) {
  throw new Error(`Generated documentation is not deterministic: ${first} != ${second}`);
}
const worktreeAfter = worktreeFingerprint();
if (worktreeBefore !== worktreeAfter) {
  throw new Error('Generated documentation build changed tracked or untracked files; generation must leave the authored tree untouched');
}

console.log(`Generated documentation verified twice: ${second}`);
