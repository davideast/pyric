import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const JOB_TMP_MARKER = '.pyric-job-tmp';
const POSIX_SHARED_TEMP_DIRS = [
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/private/var/tmp',
  '/run',
  '/dev/shm',
];

function resolveExistingRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

function addProtectedPath(paths: Set<string>, path: string): void {
  const resolved = resolve(path);
  paths.add(resolved);
  const real = resolveExistingRealPath(resolved);
  if (real !== null) {
    paths.add(real);
  }
}

function isEqualOrInsideDir(parentDir: string, candidatePath: string): boolean {
  let parentBase = resolve(parentDir);
  const parentReal = resolveExistingRealPath(parentBase);
  if (parentReal !== null) {
    parentBase = parentReal;
  }
  const rel = relative(parentBase, candidatePath);
  return rel === '' || (rel.startsWith('..') === false && isAbsolute(rel) === false);
}

function isStrictlyInsideDir(parentDir: string, candidatePath: string): boolean {
  let parentBase = resolve(parentDir);
  const parentReal = resolveExistingRealPath(parentBase);
  if (parentReal !== null) {
    parentBase = parentReal;
  }
  const rel = relative(parentBase, candidatePath);
  return rel !== '' && rel.startsWith('..') === false && isAbsolute(rel) === false;
}

function projectRealPath(path: string): string {
  const candidate = resolve(path);
  let ancestor = candidate;
  while (existsSync(ancestor) === false && isFilesystemRoot(ancestor) === false) {
    ancestor = dirname(ancestor);
  }
  const realAncestor = resolveExistingRealPath(ancestor);
  if (realAncestor === null) {
    return candidate;
  }
  const suffix = relative(ancestor, candidate);
  if (suffix === '') {
    return realAncestor;
  }
  return resolve(realAncestor, suffix);
}

function isUnsafePrivateTmpParent(dir: string): boolean {
  if (dir.trim() === '') {
    return true;
  }
  const resolved = resolve(dir);
  if (isFilesystemRoot(resolved)) {
    return true;
  }
  const real = resolveExistingRealPath(resolved);
  if (real !== null && isFilesystemRoot(real)) {
    return true;
  }
  const home = homedir();
  const blocked = new Set<string>();
  addProtectedPath(blocked, tmpdir());
  addProtectedPath(blocked, home);
  addProtectedPath(blocked, dirname(resolve(home)));
  addProtectedPath(blocked, join(home, '.cache'));
  addProtectedPath(blocked, join(home, '.pyric'));
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && xdg.trim() !== '') {
    addProtectedPath(blocked, xdg);
  }
  if (process.platform !== 'win32') {
    for (const p of POSIX_SHARED_TEMP_DIRS) {
      addProtectedPath(blocked, p);
    }
    if (typeof process.getuid === 'function') {
      addProtectedPath(blocked, `/run/user/${String(process.getuid())}`);
    }
  }
  if (blocked.has(resolved)) {
    return true;
  }
  return real !== null && blocked.has(real);
}

function isAllowlistedPrivateTmpParentPath(dir: string): boolean {
  if (isUnsafePrivateTmpParent(dir)) {
    return false;
  }
  const projected = projectRealPath(dir);
  if (isUnsafePrivateTmpParent(projected)) {
    return false;
  }
  if (isEqualOrInsideDir(tmpdir(), projected)) {
    return false;
  }
  const home = homedir();
  if (isStrictlyInsideDir(join(home, '.pyric'), projected)) {
    return true;
  }
  let cacheBase = resolve(join(home, '.cache'));
  const cacheBaseReal = resolveExistingRealPath(cacheBase);
  if (cacheBaseReal !== null) {
    cacheBase = cacheBaseReal;
  }
  const relCache = relative(cacheBase, projected);
  if (relCache === '' || relCache.startsWith('..') || isAbsolute(relCache)) {
    return false;
  }
  const firstSegment = relCache.split(sep)[0];
  return (
    firstSegment !== undefined &&
    firstSegment.startsWith('pyric-') &&
    firstSegment.length > 'pyric-'.length
  );
}

function isRealDirectory(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isDirectory();
  } catch {
    return false;
  }
}

function isRegularMarkerFile(path: string): boolean {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return st !== undefined && st.isSymbolicLink() === false && st.isFile();
  } catch {
    return false;
  }
}

function isAllowlistedExistingPrivateTmpParent(dir: string): boolean {
  if (isRealDirectory(dir) === false) {
    return false;
  }
  const realParent = resolveExistingRealPath(dir);
  if (realParent === null) {
    return false;
  }
  return (
    isAllowlistedPrivateTmpParentPath(dir) &&
    isAllowlistedPrivateTmpParentPath(realParent)
  );
}

function resolveConfiguredPrivateTmpParent(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.PYRIC_TEST_TMP_ROOT;
  if (override !== undefined && override.trim() !== '') {
    if (isAllowlistedPrivateTmpParentPath(override) === false) {
      return null;
    }
    return resolve(override);
  }
  const defaultParent = resolve(join(homedir(), '.cache', 'pyric-tmp'));
  if (isAllowlistedPrivateTmpParentPath(defaultParent) === false) {
    return null;
  }
  return defaultParent;
}

function isAllowlistedPrivateTmpChild(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isUnsafePrivateTmpParent(dir) || isRealDirectory(dir) === false) {
    return false;
  }
  const realChild = resolveExistingRealPath(dir);
  if (realChild === null || isUnsafePrivateTmpParent(realChild)) {
    return false;
  }
  if (isEqualOrInsideDir(tmpdir(), realChild)) {
    return false;
  }
  const expectedParent = resolveConfiguredPrivateTmpParent(env);
  if (
    expectedParent === null ||
    isAllowlistedExistingPrivateTmpParent(expectedParent) === false
  ) {
    return false;
  }
  const parentReal = resolveExistingRealPath(expectedParent);
  if (parentReal === null) {
    return false;
  }
  const rel = relative(parentReal, realChild);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return false;
  }
  return rel.includes(sep) === false;
}

function sanitizeJobSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  if (cleaned === '') {
    return 'jt';
  }
  return cleaned;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createPrivateJobTmpDir(label: string, env: NodeJS.ProcessEnv = process.env): string {
  let parent = resolveConfiguredPrivateTmpParent(env);
  if (parent === null) {
    parent = resolve(join(homedir(), '.cache', 'pyric-tmp'));
  }
  mkdirSync(parent, { recursive: true });
  const slug = sanitizeJobSlug(label);
  const dir = mkdtempSync(join(parent, `${slug}-`));
  writeFileSync(join(dir, JOB_TMP_MARKER), `${String(process.pid)}\n`);
  return dir;
}

export function removePrivateJobTmpDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isAllowlistedPrivateTmpChild(dir, env) === false) {
    return false;
  }
  if (isRealDirectory(dir) === false) {
    return false;
  }
  if (isRegularMarkerFile(join(dir, JOB_TMP_MARKER)) === false) {
    return false;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function reapDeadPrivateJobTmpDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  const parent = resolveConfiguredPrivateTmpParent(env);
  if (parent === null || isAllowlistedExistingPrivateTmpParent(parent) === false) {
    return removed;
  }
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    const full = join(parent, name);
    const markerPath = join(full, JOB_TMP_MARKER);
    if (isRealDirectory(full) === false || isRegularMarkerFile(markerPath) === false) {
      continue;
    }
    let ownerPid = 0;
    try {
      ownerPid = Number.parseInt(readFileSync(markerPath, 'utf8').trim(), 10);
    } catch {
      ownerPid = 0;
    }
    if (
      Number.isInteger(ownerPid) &&
      ownerPid > 0 &&
      ownerPid !== process.pid &&
      isProcessAlive(ownerPid) === false
    ) {
      if (removePrivateJobTmpDir(full, env)) {
        removed.push(name);
      }
    }
  }
  return removed;
}
