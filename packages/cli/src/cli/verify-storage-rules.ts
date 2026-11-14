/**
 * `pyric verify`: the candidate Storage rules for each bucket a session used.
 *
 * Rules come from `--rules storage=<path>` (the default bucket) and
 * `--rules storage:<bucket>=<path>`, else from `firebase.json`, resolved as
 * `pyric sandbox` and `firebase deploy` resolve them: an array entry's
 * `bucket`, a `target` that `.firebaserc` maps for the project, a single
 * `storage` object for the default bucket, and `storage.rules` when there is
 * no `storage` key. A bucket key may be a `gs://` URL; it names the bucket.
 *
 * Once any rules name a bucket, each bucket replays under its own, and a
 * recorded bucket with none replays as locked, as production creates a
 * bucket. A capture recorded in permissive mode replays such a bucket as open,
 * as the session saw it. Without rules by bucket, one ruleset governs every
 * bucket, as before.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { bundleRulesSource } from 'pyric/rules/internal/usage';
import type { SandboxOperationEvent } from 'pyric/sandbox';
import { DEFAULT_BUCKET, rulesBucketName } from 'pyric/storage/internal';

import type { PyricVerifyFixture, VerifyRulesInput } from '../verify/index.js';
import { MODULAR_SOURCE, storageRulesTargets, type StorageRulesTargets } from '../serve/rules.js';
import type { FirebaseJson } from './firebase-json.js';
import { resolveFirebaseProject } from './firebase-project.js';

/** The `--rules` values for Storage: `storage=<path>` and each `storage:<bucket>=<path>`, as typed. */
export interface StorageRulesOverrides {
  default?: string;
  buckets: Array<{ bucket: string; path: string }>;
}

export interface StorageCandidateRulesInput {
  cwd: string;
  fixtures: readonly PyricVerifyFixture[];
  overrides: StorageRulesOverrides;
  /** `firebase.json`, or null when it is missing or unreadable. */
  readFirebaseJson: () => Promise<FirebaseJson | null>;
  /** `--project`. */
  project?: string;
}

export interface StorageCandidateRules {
  rules: Pick<VerifyRulesInput, 'storage' | 'storageBuckets'>;
  /** Each rules file read: `storage` for the default bucket, `storage:<bucket>` for a named one. */
  paths: Record<string, string>;
}

/** The rules an open bucket replays under: what permissive mode answered for a bucket with no rules. */
const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

const BUCKET_PREFIX = 'storage:';

/** Whether a `--rules` service key names one Storage bucket (`storage:<bucket>`). */
export function isStorageBucketRulesKey(key: string): boolean {
  return key.startsWith(BUCKET_PREFIX);
}

/** The bucket a `storage:<bucket>` key names, without `gs://`. */
export function storageBucketOfRulesKey(key: string): string {
  const raw = key.slice(BUCKET_PREFIX.length);
  return rulesBucketName(raw, raw);
}

function storageOperations(fixture: PyricVerifyFixture): SandboxOperationEvent[] {
  return fixture.events.filter(
    (event): event is SandboxOperationEvent => event.kind === 'operation' && event.service === 'storage',
  );
}

interface StorageOperationDetail {
  bucket?: unknown;
  bucketName?: unknown;
  defaultPolicy?: unknown;
}

function detailOf(event: SandboxOperationEvent): StorageOperationDetail {
  return (event.detail ?? {}) as StorageOperationDetail;
}

/** Each name the rules saw a recorded bucket by, and the default bucket's names. */
function recordedBuckets(fixtures: readonly PyricVerifyFixture[]): { all: Set<string>; defaults: Set<string> } {
  const all = new Set<string>();
  const defaults = new Set<string>();
  for (const event of fixtures.flatMap(storageOperations)) {
    const { bucket, bucketName } = detailOf(event);
    if (typeof bucket !== 'string' || bucket === '') continue;
    const name = typeof bucketName === 'string' && bucketName !== '' ? bucketName : bucket;
    all.add(name);
    if (bucket === DEFAULT_BUCKET) defaults.add(name);
  }
  return { all, defaults };
}

/** Whether a capture was recorded in permissive mode: a bucket with no rules answered `allow`. */
function recordedPermissive(fixtures: readonly PyricVerifyFixture[]): boolean {
  return fixtures.flatMap(storageOperations).some((event) => detailOf(event).defaultPolicy === 'allow');
}

function storageTargets(
  cwd: string,
  project: ReturnType<typeof resolveFirebaseProject>,
  config: FirebaseJson | null,
): StorageRulesTargets {
  try {
    return storageRulesTargets(cwd, config, project);
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) message = error.message;
    throw new Error(message.replace(/^pyric sandbox: /, ''));
  }
}

function describeBucket(bucket: string | null): string {
  return bucket === null ? 'the default bucket' : `bucket "${bucket}"`;
}

/** Read one rules file; a file firebase.json or a flag names must exist. */
function readRules(cwd: string, file: string, bucket: string | null): { path: string; source: string } {
  const path = resolve(cwd, file);
  if (!existsSync(path)) throw new Error(`rules file not found for storage ${describeBucket(bucket)}: ${path}`);
  const realCwd = realpathSync(cwd);
  const realPath = realpathSync(path);
  const relToRoot = relative(realCwd, realPath);
  if (
    relToRoot === '..'
    || relToRoot.startsWith(`..${sep}`)
    || relToRoot.startsWith('../')
    || isAbsolute(relToRoot)
  ) {
    throw new Error(`storage rules path escapes project root for ${describeBucket(bucket)}: ${file}`);
  }
  const raw = readFileSync(path, 'utf8');
  if (MODULAR_SOURCE.test(raw)) {
    try {
      const bundled = bundleRulesSource(raw, {
        filePath: realPath,
        rootDir: realCwd,
        sourceFile: path,
        targetService: 'firebase.storage',
      });
      return { path, source: bundled };
    } catch (err) {
      let msg = String(err);
      if (err instanceof Error) msg = err.message;
      throw new Error(
        `storage rules module resolution failed for ${describeBucket(bucket)} (${path}): ${msg}`,
      );
    }
  }
  return { path, source: raw };
}

/** Resolve each bucket's candidate Storage rules; throws a message naming a rules file it cannot read. */
export async function resolveStorageCandidateRules(input: StorageCandidateRulesInput): Promise<StorageCandidateRules> {
  const { cwd } = input;
  const projectOpts: { projectDir: string; option?: string } = { projectDir: cwd };
  if (input.project) {
    projectOpts.option = input.project;
  }
  const project = resolveFirebaseProject(projectOpts);
  const targets = storageTargets(cwd, project, await input.readFirebaseJson());
  const recorded = recordedBuckets(input.fixtures);
  const defaultBucketNames = new Set<string>(recorded.defaults);
  defaultBucketNames.add(DEFAULT_BUCKET);
  if (project.projectId !== undefined) {
    const fbAppBucket = `${project.projectId}.firebasestorage.app`;
    const appspotBucket = `${project.projectId}.appspot.com`;
    const targetBucketSet = new Set(
      targets.targets
        .map((t) => t.bucket)
        .filter((b): b is string => b !== null),
    );
    if (!(targetBucketSet.has(fbAppBucket) && targetBucketSet.has(appspotBucket))) {
      defaultBucketNames.add(fbAppBucket);
      defaultBucketNames.add(appspotBucket);
    }
  }

  // The default bucket: the flag, else a single storage object or storage.rules.
  let defaultFile: string | undefined = input.overrides.default;
  const configuredDefault = targets.targets.find((target) => target.bucket === null);
  const hasDefaultFile = configuredDefault !== undefined && (configuredDefault.configured || existsSync(configuredDefault.path));
  if (defaultFile === undefined && hasDefaultFile) defaultFile = configuredDefault.path;

  // Named buckets: firebase.json, then each flag over it. The default-bucket
  // flag replaces whichever firebase.json entry names the default bucket.
  const bucketFiles = new Map<string, string>();
  for (const target of targets.targets) {
    if (target.bucket === null) continue;
    const replacedByFlag =
      input.overrides.default !== undefined
      && defaultBucketNames.has(target.bucket);
    if (!replacedByFlag) bucketFiles.set(target.bucket, target.path);
  }
  for (const override of input.overrides.buckets) bucketFiles.set(override.bucket, override.path);

  const rules: StorageCandidateRules['rules'] = {};
  const paths: Record<string, string> = {};
  if (defaultFile !== undefined) {
    const read = readRules(cwd, defaultFile, null);
    rules.storage = read.source;
    paths.storage = read.path;
  }
  if (bucketFiles.size === 0) {
    if (rules.storage === undefined) {
      throw new Error('missing candidate storage rules. Pass --rules storage=<path> or configure firebase.json.');
    }
    return { rules, paths };
  }

  const storageBuckets: Record<string, string> = {};
  for (const [bucket, file] of bucketFiles) {
    const read = readRules(cwd, file, bucket);
    storageBuckets[bucket] = read.source;
    paths[`${BUCKET_PREFIX}${bucket}`] = read.path;
  }
  if (recordedPermissive(input.fixtures)) {
    for (const bucket of recorded.all) {
      const isDefaultWithRules = recorded.defaults.has(bucket) && rules.storage !== undefined;
      if (!(bucket in storageBuckets) && !isDefaultWithRules) storageBuckets[bucket] = OPEN_RULES;
    }
  }
  rules.storageBuckets = storageBuckets;
  return { rules, paths };
}
