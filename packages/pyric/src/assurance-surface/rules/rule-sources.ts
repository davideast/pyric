/**
 * Where an app's security rules come from: files named on the command
 * line, the `firestore`, `database`, and `storage` entries of `firebase.json`
 * (single or per-target/per-bucket arrays), and rules the app installs from
 * code. RTDB rules files are read with Pyric's JSON-with-comments reader.
 *
 * Browser-clean: acquires `node:fs` and `node:path` lazily via
 * `process.getBuiltinModule` when loading files from disk.
 */
import { toStrictRulesJson } from '../../rules/internal/rtdb.js';
import {
  acquireRuleSourceBuiltins,
  assertContainedProjectFile,
  assertNotSymlink,
  bundleRulesSource,
  resolveRealRoot,
  type BundleRulesSourceOptions,
  type NodePathBuiltin,
} from './rule-source-bundler.js';
import {
  firestoreRulesEntries,
  readFirebaseRcTargetConfig,
  rtdbRulesEntries,
  storageRulesEntries,
  type FirestoreConfigEntry,
  type RtdbConfigEntry,
  type StorageConfigEntry,
} from './rule-source-targets.js';
import {
  isHeaderOnlyRulesVersionStub,
  validateRulesSourceSyntax,
} from './rules-ast-utils.js';

export { bundleRulesSource, type BundleRulesSourceOptions };

/** Firestore rules text, where it came from, and optional database target. */
export interface FirestoreRuleSource {
  source: string;
  text: string;
  database?: string;
}

/** RTDB rules object, where it came from, and optional instance target. */
export interface RtdbRuleSource {
  source: string;
  json: unknown;
  instance?: string;
}

/** Cloud Storage rules text, where it came from, and optional bucket target. */
export interface StorageRuleSource {
  source: string;
  text: string;
  bucket?: string;
}

export interface RuleSources {
  firestore: FirestoreRuleSource[];
  rtdb: RtdbRuleSource[];
  storage?: StorageRuleSource[];
  /** Files named but unreadable or unparsable, with why. */
  problems: string[];
}

/** Read an RTDB rules file, accepting comments and trailing commas. */
export function parseRtdbRulesText(text: string): unknown {
  return JSON.parse(toStrictRulesJson(text));
}

function rel(pathMod: NodePathBuiltin, root: string, file: string): string {
  return pathMod.relative(root, file).split(pathMod.sep).join('/');
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Load rules for an app root. Explicit files win; otherwise `firebase.json`
 * is read. Duplicate files (several RTDB targets sharing one file) load once.
 */
export function loadRuleSources(
  root: string,
  explicit: { firestore?: string[]; rtdb?: string[]; storage?: string[] } = {},
): RuleSources {
  const storageList: StorageRuleSource[] = [];
  const out: RuleSources = { firestore: [], rtdb: [], storage: storageList, problems: [] };
  const builtins = acquireRuleSourceBuiltins();
  if (builtins === null) {
    out.problems.push('loadRuleSources requires a Node.js filesystem runtime.');
    return out;
  }
  const { fs: fsMod, path: pathMod } = builtins;
  const absRoot = pathMod.resolve(root);
  const realRoot = resolveRealRoot(fsMod, absRoot);
  const hasExplicit =
    (explicit.firestore?.length ?? 0) > 0
    || (explicit.rtdb?.length ?? 0) > 0
    || (explicit.storage?.length ?? 0) > 0;
  let firestoreEntries: FirestoreConfigEntry[] = (explicit.firestore ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  let rtdbEntries: RtdbConfigEntry[] = (explicit.rtdb ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  let storageEntries: StorageConfigEntry[] = (explicit.storage ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  if (!hasExplicit) {
    const rcConfig = readFirebaseRcTargetConfig(builtins, absRoot, realRoot);
    const config = pathMod.join(absRoot, 'firebase.json');
    if (fsMod.existsSync(config)) {
      try {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, config);
        const rawConfig = JSON.parse(fsMod.readFileSync(config, 'utf8')) as unknown;
        if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
          throw new Error('firebase.json must contain a JSON object');
        }
        const parsed = rawConfig as {
          firestore?: unknown;
          database?: unknown;
          storage?: unknown;
        };
        if (firestoreEntries.length === 0) {
          firestoreEntries = firestoreRulesEntries(parsed.firestore, rcConfig).map((entry) => {
            const resolved: FirestoreConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.database !== undefined) resolved.database = entry.database;
            return resolved;
          });
        }
        if (rtdbEntries.length === 0) {
          rtdbEntries = rtdbRulesEntries(parsed.database, rcConfig).map((entry) => {
            const resolved: RtdbConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.instance !== undefined) resolved.instance = entry.instance;
            return resolved;
          });
        }
        if (storageEntries.length === 0) {
          storageEntries = storageRulesEntries(parsed.storage, rcConfig).map((entry) => {
            const resolved: StorageConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.bucket !== undefined) resolved.bucket = entry.bucket;
            return resolved;
          });
        }
      } catch (e) {
        out.problems.push(`firebase.json: ${errorText(e)}`);
      }
    }
  }
  for (const item of firestoreEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const sourceLabel = rel(pathMod, absRoot, item.file);
      const rawText = fsMod.readFileSync(item.file, 'utf8');
      const bundleOpts: {
        filePath: string;
        rootDir?: string;
        sourceFile: string;
        targetService: 'cloud.firestore';
      } = {
        filePath: item.file,
        sourceFile: sourceLabel,
        targetService: 'cloud.firestore',
      };
      if (item.fromProject) bundleOpts.rootDir = absRoot;
      const bundledText = bundleRulesSource(rawText, bundleOpts);
      if (!isHeaderOnlyRulesVersionStub(bundledText)) {
        const syntax = validateRulesSourceSyntax(bundledText, 'cloud.firestore', {
          sourceFile: sourceLabel,
          targetService: 'cloud.firestore',
        });
        if (!syntax.ok) {
          throw new Error(syntax.message);
        }
      }
      const loaded: FirestoreRuleSource = {
        source: sourceLabel,
        text: bundledText,
      };
      if (item.database !== undefined) loaded.database = item.database;
      out.firestore.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  for (const item of rtdbEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const loaded: RtdbRuleSource = {
        source: rel(pathMod, absRoot, item.file),
        json: parseRtdbRulesText(fsMod.readFileSync(item.file, 'utf8')),
      };
      if (item.instance !== undefined) loaded.instance = item.instance;
      out.rtdb.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  for (const item of storageEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const sourceLabel = rel(pathMod, absRoot, item.file);
      const rawText = fsMod.readFileSync(item.file, 'utf8');
      const bundleOpts: {
        filePath: string;
        rootDir?: string;
        sourceFile: string;
        targetService: 'firebase.storage';
      } = {
        filePath: item.file,
        sourceFile: sourceLabel,
        targetService: 'firebase.storage',
      };
      if (item.fromProject) bundleOpts.rootDir = absRoot;
      const bundledText = bundleRulesSource(rawText, bundleOpts);
      if (!isHeaderOnlyRulesVersionStub(bundledText)) {
        const syntax = validateRulesSourceSyntax(bundledText, 'firebase.storage', {
          sourceFile: sourceLabel,
          targetService: 'firebase.storage',
        });
        if (!syntax.ok) {
          throw new Error(syntax.message);
        }
      }
      const loaded: StorageRuleSource = {
        source: sourceLabel,
        text: bundledText,
      };
      if (item.bucket !== undefined) loaded.bucket = item.bucket;
      storageList.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  return out;
}
