/**
 * Minimal `firebase.json` / `.firebaserc` reader for the CLI.
 *
 * Surfaces only the fields the subcommands actually touch -- the
 * full firebase.json schema is huge and a full parse isn't needed
 * for any current subcommand. New fields land alongside the
 * subcommand that consumes them.
 *
 * `.firebaserc` carries the project id under `projects.default`;
 * the standard Firebase CLI uses the same convention.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatPyricCommand } from './command-hint.js';
import { missingPublicDirHint } from './public-dir-hint.js';

interface HostingRewriteConfig {
  source?: string;
  regex?: string;
  glob?: string;
  destination?: string;
  function?: unknown;
  run?: unknown;
  dynamicLinks?: boolean;
}

interface HostingConfig {
  public?: string;
  source?: string;
  rewrites?: HostingRewriteConfig[];
  redirects?: unknown[];
  i18n?: unknown;
}

interface ResolvedHostingSite {
  /** Resolved static directory from `hosting.public`, or `null` when no static directory is served. */
  publicDir: string | null;
  /** Configured `hosting.public` label for diagnostics and startup lines, or `null` when unset. */
  publicLabel: string | null;
}

export interface FirebaseJson {
  /**
   * Firestore rules and indexes, as the Firebase CLI reads them: one object
   * that deploys to its `database`, or to `(default)`, or an array whose
   * entries each name a `database`, or a `target` that `.firebaserc` maps to
   * databases. `firestoreRulesConfig` in `pyric/sandbox/internal` resolves it.
   */
  firestore?: FirestoreConfig | FirestoreConfigEntry[];
  /**
   * Realtime Database rules, as the Firebase CLI reads them: one object whose
   * `rules` file deploys to the project's default instance, or an array whose
   * entries each name an `instance`, or a `target` that `.firebaserc` maps
   * to instances.
   */
  database?: DatabaseRulesConfig | DatabaseRulesEntry[];
  hosting?: unknown;
  functions?: unknown;
  /** Storage rules + (optional) target bucket. A single object, or an array for
   *  multi-bucket projects. `rules` is a path; `bucket` overrides the default
   *  `{projectId}.firebasestorage.app`. */
  storage?: { rules?: string; bucket?: string } | Array<{ rules?: string; bucket?: string }>;
}

/** The single-object `firestore` form. */
export interface FirestoreConfig {
  rules?: string;
  indexes?: string;
  /** The database the object deploys to. Defaults to `(default)`. */
  database?: string;
}

/** One entry of the array `firestore` form. */
export interface FirestoreConfigEntry extends FirestoreConfig {
  /** A deploy target that `.firebaserc` maps to database ids. Wins over `database`. */
  target?: string;
  /**
   * Pyric's own key, never in a `firebase.json`: the rules file a Vite or
   * `pyric.config` override serves on `(default)`. See `withDefaultFirestoreRules`.
   */
  pyricRulesOverride?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDestinationRewrite(rewrite: unknown): boolean {
  return typeof rewrite === 'object' && rewrite !== null && 'destination' in rewrite;
}

function isDynamicRewrite(rewrite: unknown): boolean {
  return typeof rewrite === 'object' && rewrite !== null && !('destination' in rewrite);
}

/**
 * Extract the single hosting config `pyric sandbox` supports. Arrays
 * (multi-site) take the first entry with a warning -- multi-site is out of
 * scope (plan section 6).
 */
export function extractHosting(config: FirebaseJson | null): HostingConfig | null {
  const hosting = config?.hosting;
  if (!hosting || typeof hosting !== 'object') return null;
  if (Array.isArray(hosting)) {
    const first = hosting[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
    return first as HostingConfig;
  }
  return hosting as HostingConfig;
}

/** firebase.json's SPA idiom: a `**` rewrite to `/index.html`. */
export function wantsSpaRewrite(hosting: HostingConfig | null): boolean {
  const rewrites = Array.isArray(hosting?.rewrites) ? hosting.rewrites : [];
  return rewrites.some((r) => r.source === '**' && r.destination === '/index.html');
}

/**
 * Validate a `hosting` block against `firebase-tools` (`lib/hosting/config.js`)
 * and resolve its served static directory (#1779, #1825).
 *
 * `firebase-tools` sets `root = source || public` with no `'public'` default:
 * a block without `public` or `source` is accepted when it has a dynamic
 * rewrite or redirect and no `destination` rewrite or `i18n` config, and deploys
 * no static files (`publicDir: null`).
 */
export function resolveHostingSite(
  cwd: string,
  hosting: HostingConfig | null,
  options: { hosted?: boolean } = {},
): ResolvedHostingSite {
  if (hosting === null) {
    return { publicDir: null, publicLabel: null };
  }
  const sourceName = hosting.source;
  const publicName = hosting.public;
  const hasSource = isNonEmptyString(sourceName);
  const hasPublic = isNonEmptyString(publicName);
  if (hasSource && hasPublic) {
    throw new Error('pyric sandbox: Can only specify "source" or "public" in a Hosting config, not both.');
  }

  const rewrites = Array.isArray(hosting.rewrites) ? hosting.rewrites : [];
  const redirects = Array.isArray(hosting.redirects) ? hosting.redirects : [];
  const hasStaticRewrite = rewrites.some(isDestinationRewrite);
  const hasDynamicRewrite = rewrites.some(isDynamicRewrite);
  const hasRedirects = redirects.length > 0;
  const hasI18n = hosting.i18n !== undefined && hosting.i18n !== null && hosting.i18n !== false;
  const hasRoot = hasSource || hasPublic;

  if (!hasRoot && hasStaticRewrite) {
    throw new Error(
      'pyric sandbox: Must supply a "public" or "source" directory when using "destination" rewrites.',
    );
  }
  if (!hasRoot && hasI18n) {
    throw new Error(
      'pyric sandbox: Must supply a "public" or "source" directory when using "i18n" configuration.',
    );
  }
  if (!hasRoot && !hasDynamicRewrite && !hasRedirects) {
    throw new Error(
      'pyric sandbox: Must supply a "public" or "source" directory or at least one rewrite or redirect in each "hosting" config.',
    );
  }

  if (hasSource) {
    const sourceDir = resolve(cwd, sourceName);
    if (!existsSync(sourceDir)) {
      const hint = missingPublicDirHint(sourceDir, { cwd, hosted: options.hosted === true });
      throw new Error(`pyric sandbox: hosting.source directory does not exist: ${sourceDir}${hint}`);
    }
    return { publicDir: null, publicLabel: null };
  }

  if (hasPublic) {
    const publicDir = resolve(cwd, publicName);
    if (!existsSync(publicDir)) {
      const hint = missingPublicDirHint(publicDir, { cwd, hosted: options.hosted === true });
      throw new Error(`pyric sandbox: hosting.public directory does not exist: ${publicDir}${hint}`);
    }
    return { publicDir, publicLabel: publicName };
  }

  return { publicDir: null, publicLabel: null };
}

/** The startup line for a project that serves no static site. */
export function hostingNoStaticSiteLine(hasFirebaseJson: boolean, hasHostingBlock: boolean): string {
  if (!hasFirebaseJson) {
    return '\u2022 hosting  Off: no firebase.json. Add one with hosting.public to serve a site.';
  }
  if (!hasHostingBlock) {
    return '\u2022 hosting  Off: firebase.json has no hosting block. Add hosting.public to serve a site.';
  }
  return '\u2022 hosting  No static files: hosting.public is not set.';
}

/**
 * `firestore` with `rules` served on `(default)` in place of what it names
 * there. An object gets the `rules` key. An array gets a
 * `{ pyricRulesOverride: rules }` entry, which `firestoreRulesConfig` applies
 * after it resolves the array, so the override reaches `(default)` however
 * the array deploys to it, through `database` or a `.firebaserc` target.
 */
export function withDefaultFirestoreRules(
  firestore: FirebaseJson['firestore'],
  rules: string,
): FirestoreConfig | FirestoreConfigEntry[] {
  if (!Array.isArray(firestore)) {
    const namedOnObject =
      firestore !== undefined &&
      typeof firestore.database === 'string' &&
      firestore.database !== '' &&
      firestore.database !== '(default)';
    if (namedOnObject) {
      return [firestore, { pyricRulesOverride: rules }];
    }
    return { ...firestore, rules };
  }
  const entries = firestore.filter((entry) => entry.pyricRulesOverride === undefined);
  return [...entries, { pyricRulesOverride: rules }];
}

/** The single-object `database` form: `rules` deploys to the default instance. */
interface DatabaseRulesConfig {
  rules?: string;
}

/** One entry of the array `database` form. */
interface DatabaseRulesEntry {
  /** The instance name the entry's rules deploy to. */
  instance?: string;
  /** A deploy target that `.firebaserc` maps to instance names. Wins over `instance`. */
  target?: string;
  rules?: string;
}

/** The rules file a single-object `database` config names; undefined for the array form. */
export function singleDatabaseRulesFile(config: FirebaseJson | null): string | undefined {
  const database = config?.database;
  if (Array.isArray(database)) return undefined;
  return database?.rules;
}

export interface FirebaseRc {
  projects?: {
    default?: string;
    [alias: string]: string | undefined;
  };
  /**
   * Deploy-target maps, keyed project -> resource type -> target name ->
   * resource ids (mirrors firebase-tools' RCData,
   * clones/firebase-tools/src/rc.ts:28-36). `hosting` (target -> site ids),
   * `database` (target -> instance names) and `firestore` (target -> database
   * ids) are consumed.
   */
  targets?: {
    [projectId: string]: {
      [targetType: string]: {
        [targetName: string]: string[] | undefined;
      } | undefined;
    } | undefined;
  };
}

/**
 * Read + parse `firebase.json` from `cwd`. Throws when missing -- every
 * subcommand that needs project metadata expects a present file.
 */
export async function readFirebaseJson(cwd: string = process.cwd()): Promise<FirebaseJson> {
  const path = join(cwd, 'firebase.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const initCmd = formatPyricCommand('init');
      throw new Error(`pyric: no firebase.json found at ${path}. Run \`${initCmd}\` to scaffold one.`);
    }
    throw e;
  }
  try {
    return JSON.parse(raw) as FirebaseJson;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`pyric: failed to parse firebase.json: ${detail}`);
  }
}

/**
 * Read + parse `.firebaserc` from `cwd`. Returns null when missing --
 * the project id can also come from `--project` / `PYRIC_PROJECT`, so
 * absence is not fatal at this layer.
 */
export async function readFirebaseRc(cwd: string = process.cwd()): Promise<FirebaseRc | null> {
  const path = join(cwd, '.firebaserc');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return parseFirebaseRc(raw);
}

/** {@link readFirebaseRc}, synchronously. */
export function readFirebaseRcSync(cwd: string): FirebaseRc | null {
  const path = join(cwd, '.firebaserc');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return parseFirebaseRc(raw);
}

function parseFirebaseRc(raw: string): FirebaseRc {
  try {
    return JSON.parse(raw) as FirebaseRc;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`pyric: failed to parse .firebaserc: ${detail}`);
  }
}
