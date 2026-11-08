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

interface NodeFsBuiltin {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync?: (path: string) => { isSymbolicLink(): boolean };
}

interface NodePathBuiltin {
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

interface RuleSourceBuiltins {
  readonly fs: NodeFsBuiltin;
  readonly path: NodePathBuiltin;
}

function acquireRuleSourceBuiltins(): RuleSourceBuiltins | null {
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }
  ).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(proc, 'node:fs') as NodeFsBuiltin | undefined;
  const path = get.call(proc, 'node:path') as NodePathBuiltin | undefined;
  if (!fs || !path || typeof fs.readFileSync !== 'function') return null;
  return { fs, path };
}

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

function assertNotSymlink(fsMod: NodeFsBuiltin, file: string): void {
  if (typeof fsMod.lstatSync !== 'function') return;
  if (fsMod.lstatSync(file).isSymbolicLink()) {
    throw new Error('Symbolic links are not followed');
  }
}

interface FirestoreConfigEntry {
  file: string;
  database?: string;
}

interface RtdbConfigEntry {
  file: string;
  instance?: string;
}

interface StorageConfigEntry {
  file: string;
  bucket?: string;
}

function firestoreRulesEntries(section: unknown): FirestoreConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: FirestoreConfigEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; database?: unknown };
    if (typeof rec.rules !== 'string') continue;
    let database: string | undefined;
    if (typeof rec.database === 'string' && rec.database.length > 0) {
      database = rec.database;
    }
    const key = `${database ?? ''}|${rec.rules}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: FirestoreConfigEntry = { file: rec.rules };
    if (database !== undefined) entry.database = database;
    out.push(entry);
  }
  return out;
}

function rtdbRulesEntries(section: unknown): RtdbConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: RtdbConfigEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; instance?: unknown };
    if (typeof rec.rules !== 'string') continue;
    let instance: string | undefined;
    if (typeof rec.instance === 'string' && rec.instance.length > 0) {
      instance = rec.instance;
    }
    const key = `${instance ?? ''}|${rec.rules}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: RtdbConfigEntry = { file: rec.rules };
    if (instance !== undefined) entry.instance = instance;
    out.push(entry);
  }
  return out;
}

function storageRulesEntries(section: unknown): StorageConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: StorageConfigEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; bucket?: unknown };
    if (typeof rec.rules !== 'string') continue;
    let bucket: string | undefined;
    if (typeof rec.bucket === 'string' && rec.bucket.length > 0) {
      bucket = rec.bucket;
    }
    const key = `${bucket ?? ''}|${rec.rules}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: StorageConfigEntry = { file: rec.rules };
    if (bucket !== undefined) entry.bucket = bucket;
    out.push(entry);
  }
  return out;
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
    const config = pathMod.join(absRoot, 'firebase.json');
    if (fsMod.existsSync(config)) {
      try {
        assertNotSymlink(fsMod, config);
        const parsed = JSON.parse(fsMod.readFileSync(config, 'utf8')) as {
          firestore?: unknown;
          database?: unknown;
          storage?: unknown;
        };
        if (firestoreEntries.length === 0) {
          firestoreEntries = firestoreRulesEntries(parsed.firestore).map((entry) => {
            const resolved: FirestoreConfigEntry = { file: pathMod.join(absRoot, entry.file) };
            if (entry.database !== undefined) resolved.database = entry.database;
            return resolved;
          });
        }
        if (rtdbEntries.length === 0) {
          rtdbEntries = rtdbRulesEntries(parsed.database).map((entry) => {
            const resolved: RtdbConfigEntry = { file: pathMod.join(absRoot, entry.file) };
            if (entry.instance !== undefined) resolved.instance = entry.instance;
            return resolved;
          });
        }
        if (storageEntries.length === 0) {
          storageEntries = storageRulesEntries(parsed.storage).map((entry) => {
            const resolved: StorageConfigEntry = { file: pathMod.join(absRoot, entry.file) };
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
      assertNotSymlink(fsMod, item.file);
      const loaded: FirestoreRuleSource = {
        source: rel(pathMod, absRoot, item.file),
        text: fsMod.readFileSync(item.file, 'utf8'),
      };
      if (item.database !== undefined) loaded.database = item.database;
      out.firestore.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  for (const item of rtdbEntries) {
    try {
      assertNotSymlink(fsMod, item.file);
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
      assertNotSymlink(fsMod, item.file);
      const loaded: StorageRuleSource = {
        source: rel(pathMod, absRoot, item.file),
        text: fsMod.readFileSync(item.file, 'utf8'),
      };
      if (item.bucket !== undefined) loaded.bucket = item.bucket;
      storageList.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  return out;
}
