/**
 * The Storage rules a `firebase.json` deploys, per bucket.
 *
 * Resolved as `firebase deploy` resolves them (firebase-tools 15.24.0,
 * `lib/deploy/storage/prepare.js` and `release.js`):
 *
 * - A single `storage` object's `rules` deploys to the project's default
 *   bucket. Without `rules` it deploys nothing. With a `target`, it deploys
 *   as an array entry with that target does: `prepare.js` sets the default
 *   bucket on it, and `release.js` checks `target` first.
 * - A bucket name is used as written. A `gs://` URL is refused, since
 *   `release.js` would release to a bucket by that literal name.
 * - An array entry with `target` deploys to every bucket `.firebaserc` maps
 *   under `targets.<project>.storage.<target>`. A target no mapping resolves
 *   is returned in `unresolved`; the caller decides what that means for it
 *   (the CLI's `requireTarget` refuses the deploy).
 * - An array entry without `target` deploys to its `bucket`. An entry with
 *   neither has no bucket to release to, and is refused, naming it. An entry
 *   without `rules` deploys nothing here.
 * - Every bucket's release happens at once, so two entries that deploy
 *   different files to one bucket leave production's choice undetermined,
 *   and are refused.
 * - Without a `storage` key, `storage.rules` in the project deploys to the
 *   default bucket when it exists (`configured: false`).
 *
 * The default bucket is the app's `storageBucket`, which `firebase.json` does
 * not name, so its rules come back on their own as `defaultRules`. A bucket an
 * array entry names keeps its name, and the caller matches it against the
 * app's bucket.
 *
 * Pure: it reads no file. Errors are plain `Error`s whose message names the
 * `firebase.json` entry; callers prefix them with their own context.
 */

/** The rules file read when `firebase.json` has no `storage` key. */
export const DEFAULT_STORAGE_RULES_FILE = 'storage.rules';

/** One rules file and the `firebase.json` entry that deploys it. */
export interface StorageRulesFile {
  /** The rules file, as `resolveFile` returned it. */
  file: string;
  /** The `firebase.json` entry, such as `firebase.json storage[0]`. */
  label: string;
  /** True when `firebase.json` names the file, so a missing file is an error. */
  configured: boolean;
}

/** One rules file deployed to one named bucket. */
export interface StorageRulesBucketTarget extends StorageRulesFile {
  /** The bucket name, as `firebase.json` or `.firebaserc` names it. */
  bucket: string;
}

/** A target entry whose target no `.firebaserc` mapping resolved. */
export interface UnresolvedStorageRulesTarget {
  /** The deploy target name. */
  target: string;
  /** The `firebase.json` entry, such as `firebase.json storage[0]`. */
  label: string;
  /** The rules file, as `resolveFile` returned it. */
  file: string;
}

export interface StorageRulesConfig {
  /** The rules the default bucket gets from the single-object form or `storage.rules`, else null. */
  defaultRules: StorageRulesFile | null;
  /** One entry per named bucket, in `firebase.json` order. */
  buckets: StorageRulesBucketTarget[];
  /** Target entries no mapping resolved, in `firebase.json` order. */
  unresolved: UnresolvedStorageRulesTarget[];
}

export interface StorageRulesConfigOptions {
  /**
   * The bucket names `.firebaserc` maps a deploy target to for the project,
   * as read from the file. A value that is not an array of names maps the
   * target to no bucket.
   */
  targetBuckets?: (target: string) => unknown;
  /** The rules file as the caller reads it, such as an absolute path. Defaults to the name as written. */
  resolveFile?: (file: string) => string;
}

interface StorageRulesEntry {
  bucket?: unknown;
  target?: unknown;
  rules?: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The buckets one array entry deploys to, or the target it could not map. */
function entryBuckets(
  entry: StorageRulesEntry,
  label: string,
  options: StorageRulesConfigOptions,
): readonly string[] {
  if (nonEmptyString(entry.target)) {
    const mapped = options.targetBuckets?.(entry.target);
    return Array.isArray(mapped) ? mapped.filter(nonEmptyString) : [];
  }
  if (nonEmptyString(entry.bucket)) {
    if (entry.bucket.startsWith('gs://')) {
      throw new Error(`${label} names bucket "${entry.bucket}", a gs:// URL. firebase deploy releases to a bucket by that literal name. Write the bucket name without gs://, as "${entry.bucket.slice('gs://'.length).replace(/\/$/, '')}".`);
    }
    return [entry.bucket];
  }
  throw new Error(`${label} names neither "bucket" nor "target", so firebase deploy has no bucket to release its rules to. Add "bucket": "<bucket name>".`);
}

/** Add one bucket's deploy, refusing a second, different file for the same bucket. */
function addBucket(buckets: StorageRulesBucketTarget[], next: StorageRulesBucketTarget): void {
  const existing = buckets.find((target) => target.bucket === next.bucket);
  if (existing === undefined) {
    buckets.push(next);
    return;
  }
  if (existing.file === next.file) return;
  throw new Error(
    `firebase.json deploys two rules files to Storage bucket "${next.bucket}": ${existing.file} from ${existing.label} and ${next.file} from ${next.label}. The Firebase CLI releases both at once, so the configuration does not determine which one production keeps. Deploy one rules file to each bucket.`,
  );
}

/** Resolve the `storage` value of a `firebase.json` to the rules each bucket gets. */
export function storageRulesConfig(
  storage: unknown,
  options: StorageRulesConfigOptions = {},
): StorageRulesConfig {
  const resolveFile = options.resolveFile ?? ((file: string) => file);
  if (storage === undefined || storage === null) {
    const file = resolveFile(DEFAULT_STORAGE_RULES_FILE);
    return { defaultRules: { file, label: 'firebase.json', configured: false }, buckets: [], unresolved: [] };
  }
  const targetedObject = !Array.isArray(storage) && typeof storage === 'object' && nonEmptyString((storage as StorageRulesEntry).target);
  if (targetedObject) {
    const resolved = storageRulesConfig([storage], options);
    const relabel = (label: string): string => label.replace('storage[0]', 'storage');
    return {
      defaultRules: null,
      buckets: resolved.buckets.map((target) => ({ ...target, label: relabel(target.label) })),
      unresolved: resolved.unresolved.map((target) => ({ ...target, label: relabel(target.label) })),
    };
  }
  if (!Array.isArray(storage)) {
    const rules = typeof storage === 'object' ? (storage as StorageRulesEntry).rules : undefined;
    if (!nonEmptyString(rules)) return { defaultRules: null, buckets: [], unresolved: [] };
    const label = 'firebase.json storage.rules';
    return { defaultRules: { file: resolveFile(rules), label, configured: true }, buckets: [], unresolved: [] };
  }

  const buckets: StorageRulesBucketTarget[] = [];
  const unresolved: UnresolvedStorageRulesTarget[] = [];
  storage.forEach((raw: unknown, index) => {
    const label = `firebase.json storage[${index}]`;
    const entry: StorageRulesEntry = raw !== null && typeof raw === 'object' ? raw : {};
    const names = entryBuckets(entry, label, options);
    if (!nonEmptyString(entry.rules)) return;
    const file = resolveFile(entry.rules);
    const unmapped = names.length === 0 && nonEmptyString(entry.target);
    if (unmapped) {
      unresolved.push({ target: entry.target as string, label, file });
      return;
    }
    for (const bucket of names) addBucket(buckets, { bucket, file, label, configured: true });
  });
  return { defaultRules: null, buckets, unresolved };
}
