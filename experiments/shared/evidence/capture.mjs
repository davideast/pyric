import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink, unlink, lstat } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const experiment = 'experiments/multiplayer/pixel-together';
const sourcePaths = [
  `${experiment}/execute.mjs`,
  `${experiment}/architecture/pixels.mjs`,
  `${experiment}/architecture/claims.mjs`,
  `${experiment}/architecture/paired-claims.mjs`,
  `${experiment}/architecture/firestore.rules`,
  `${experiment}/fixtures/workload.mjs`,
  `${experiment}/scenarios/harness.mjs`,
  `${experiment}/scenarios/claim-lifecycle.mjs`,
  `${experiment}/scenarios/contention.mjs`,
  `${experiment}/scenarios/paired-ownership.mjs`,
  'experiments/shared/backends/pyric.mjs',
  'experiments/shared/evidence/compare.mjs',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validPath = path => typeof path === 'string' && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');

export async function verifyCapture(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const issues = [];
  if (manifest.formatVersion !== 1 || manifest.execution !== 'copied-source' || !Array.isArray(manifest.files)) return { valid: false, issues: ['unsupported manifest'] };
  const selected = manifest.experiment ?? experiment;
  if (!validPath(selected) || !selected.startsWith('experiments/')) return { valid: false, issues: ['Invalid experiment path'] };
  const artifacts = manifest.artifacts ?? ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md'];
  if (!Array.isArray(artifacts) || artifacts.some(path=>!validPath(path))) return { valid: false, issues: ['Invalid artifacts'] };
  const required = [`source/${selected}/execute.mjs`, 'result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md', ...artifacts, ...(manifest.hasInput ? ['input.json'] : [])];
  if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) issues.push('Duplicate manifest paths');
  for (const path of required) if (manifest.files.filter(file => file.path === path).length !== 1) issues.push(`Missing or duplicate: ${path}`);
  for (const file of manifest.files) {
    if (!validPath(file.path)) { issues.push('Invalid relative path'); continue; }
    try {
      const path = join(directory, file.path);
      // Captures contain regular files, never external-source links.
      if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== file.sha256) issues.push(`Changed: ${file.path}`);
    } catch { issues.push(`Unavailable: ${file.path}`); }
  }
  const sourceFiles = manifest.files.filter(file => file.path.startsWith('source/'));
  if (digest(JSON.stringify(sourceFiles)) !== manifest.sourceSnapshotHash) issues.push('Source snapshot digest mismatch');
  try {
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    if (result.run.id !== manifest.runId) issues.push('Run ID mismatch');
  } catch { issues.push('Unreadable result'); }
  return { valid: issues.length === 0, issues };
}

/** Copy first, execute that copy, retain it beside evidence. No Git checkout required.
 * @param {string} output
 * @param {{sourceCapture?: string, definition?: {experiment: string, sourcePaths: string[], artifacts?: string[], recoverOnFailure?: boolean, scope?: string, replayAllowed?: boolean, executionTimeoutMs?: number}, input?: unknown}} options
 */
export async function captureRun(output, { sourceCapture, definition, input } = {}) {
  let parent;
  if (sourceCapture) {
    const verification = await verifyCapture(sourceCapture);
    if (!verification.valid) throw new Error(`Snapshot verification failed: ${verification.issues.join(', ')}`);
    parent = JSON.parse(await readFile(join(sourceCapture, 'manifest.json'), 'utf8'));
    if (parent.replayAllowed === false) throw new Error('Replay is disabled for this capture; inspect evidence without reissuing requests');
  }
  const executionTimeoutMs = parent?.executionTimeoutMs ?? definition?.executionTimeoutMs ?? 60000;
  if (!Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1000 || executionTimeoutMs > 300000) throw new Error('Invalid capture execution timeout');
  const selected = parent?.experiment ?? definition?.experiment ?? experiment;
  const artifacts = parent?.artifacts ?? definition?.artifacts ?? ['result.json', 'assessment.json', 'workload.json', 'firestore.rules', 'findings.md'];
  if (!validPath(selected) || !selected.startsWith('experiments/') || artifacts.some(path=>!validPath(path))) throw new Error('Invalid capture definition');
  const recoverOnFailure = parent?.recoverOnFailure ?? definition?.recoverOnFailure ?? false;
  const id = randomUUID();
  const directory = resolve(output, id);
  await mkdir(directory, { recursive: true });
  const files = [];
  const paths = parent ? parent.files.filter(file => file.path.startsWith('source/')).map(file => file.path.slice(7)) : (definition?.sourcePaths ?? sourcePaths);
  if (paths.some(path=>!validPath(path) || !path.startsWith('experiments/'))) throw new Error('Invalid source paths');
  for (const path of paths) {
    const bytes = await readFile(sourceCapture ? join(sourceCapture, 'source', path) : join(repo, path));
    const target = join(directory, 'source', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    files.push({ path: `source/${path}`, sha256: digest(bytes), bytes: bytes.length });
  }
  if (parent?.hasInput || input !== undefined) {
    const bytes = input !== undefined ? JSON.stringify(input, null, 2) + '\n' : await readFile(join(sourceCapture, 'input.json'));
    await writeFile(join(directory, 'input.json'), bytes);
  }
  const gitRevision = parent?.gitRevision ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  // Temporary dependency resolution only. The link is removed before archiving.
  const modules = join(directory, 'source/node_modules');
  await symlink(join(repo, 'node_modules'), modules, 'dir');
  let executionFailed = false;
  try {
    const child = spawnSync(process.execPath, [join(directory, 'source', selected, 'execute.mjs'), directory], {
      cwd: directory, encoding: 'utf8', timeout: executionTimeoutMs,
      env: { ...process.env, PYRIC_EXPERIMENT_REVISION: gitRevision, PYRIC_EXPERIMENT_RUN_ID: id, PYRIC_EXPERIMENT_REPLAY: parent ? '1' : '' },
    });
    /** @type {NodeJS.ErrnoException | undefined} */
    const executionError = child.error;
    if (child.error || child.status !== 0) {
      executionFailed = true;
      await writeFile(join(directory, 'execution-error.txt'), recoverOnFailure ? JSON.stringify({ exitCode: child.status, signal: child.signal, errorCode: executionError?.code ?? null }) : child.error?.message ?? child.stderr);
      if (!recoverOnFailure) throw new Error(`Snapshot execution failed; retained diagnostic at ${directory}/execution-error.txt`);
      const recovery = spawnSync(process.execPath, [join(directory, 'source', selected, 'execute.mjs'), directory, '--recover'], {
        cwd: directory, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PYRIC_ALLOWANCE_PRODUCTION: '', PYRIC_EXPERIMENT_REVISION: gitRevision, PYRIC_EXPERIMENT_RUN_ID: id },
      });
      if (recovery.error || recovery.status !== 0) throw new Error(`Incomplete capture could not be finalized: ${directory}`);
    }
  } finally { await unlink(modules); }
  for (const path of [...artifacts, ...(executionFailed ? ['execution-error.txt'] : []), ...((parent?.hasInput || input !== undefined) ? ['input.json'] : [])]) {
    const bytes = await readFile(join(directory, path));
    files.push({ path, sha256: digest(bytes), bytes: bytes.length });
  }
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  const manifest = {
    formatVersion: 1, replayAllowed: parent?.replayAllowed ?? definition?.replayAllowed ?? true, executionTimeoutMs, recoverOnFailure, executionFailed, experiment: selected, artifacts, hasInput: parent?.hasInput || input !== undefined, runId: id, execution: 'copied-source', gitRevision,
    parentRunId: parent?.runId ?? null,
    inputOverridden: !!parent && input !== undefined,
    sourceSnapshotHash: digest(JSON.stringify(files.filter(file => file.path.startsWith('source/')))),
    environment: result.run.environment,
    dependencyLockHash: digest(await readFile(join(repo, 'bun.lock'))),
    dependenciesBundled: false,
    scope: parent?.scope ?? definition?.scope ?? 'Synthetic multiplayer architecture and test harness; no Kin UI or backend binaries included',
    files,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const verification = await verifyCapture(directory);
  if (!verification.valid) throw new Error(`Capture changed during execution: ${verification.issues.join(', ')}`);
  const assessment = JSON.parse(await readFile(join(directory, 'assessment.json'), 'utf8'));
  return { directory, ...assessment };
}
