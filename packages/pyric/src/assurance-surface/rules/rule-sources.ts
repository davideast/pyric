/**
 * Where an app's security rules come from: files named on the command
 * line, the `firestore`, `database`, and `storage` entries of `firebase.json`
 * (single or per-target/per-bucket arrays), and rules the app installs from
 * code. RTDB rules files are read with Pyric's JSON-with-comments reader.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { toStrictRulesJson } from '../../rules/internal/rtdb.js';

/** Firestore rules text and where it came from. */
export interface FirestoreRuleSource {
  source: string;
  text: string;
}

/** RTDB rules object and where it came from. */
export interface RtdbRuleSource {
  source: string;
  json: unknown;
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

function rel(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function rulesEntries(section: unknown): string[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const out: string[] = [];
  for (const e of entries) {
    const rules = (e as { rules?: unknown } | null)?.rules;
    if (typeof rules === 'string' && !out.includes(rules)) out.push(rules);
  }
  return out;
}

interface StorageConfigEntry {
  file: string;
  bucket?: string;
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
  const absRoot = resolve(root);
  const storageList: StorageRuleSource[] = [];
  const out: RuleSources = { firestore: [], rtdb: [], storage: storageList, problems: [] };
  const hasExplicit =
    (explicit.firestore?.length ?? 0) > 0
    || (explicit.rtdb?.length ?? 0) > 0
    || (explicit.storage?.length ?? 0) > 0;
  let firestoreFiles = (explicit.firestore ?? []).map((f) => resolve(f));
  let rtdbFiles = (explicit.rtdb ?? []).map((f) => resolve(f));
  let storageEntries: StorageConfigEntry[] = (explicit.storage ?? []).map((f) => ({
    file: resolve(f),
  }));
  if (!hasExplicit) {
    const config = join(absRoot, 'firebase.json');
    if (existsSync(config)) {
      try {
        const parsed = JSON.parse(readFileSync(config, 'utf8')) as {
          firestore?: unknown;
          database?: unknown;
          storage?: unknown;
        };
        if (firestoreFiles.length === 0) {
          firestoreFiles = rulesEntries(parsed.firestore).map((f) => join(absRoot, f));
        }
        if (rtdbFiles.length === 0) {
          rtdbFiles = rulesEntries(parsed.database).map((f) => join(absRoot, f));
        }
        if (storageEntries.length === 0) {
          storageEntries = storageRulesEntries(parsed.storage).map((entry) => {
            const resolved: StorageConfigEntry = { file: join(absRoot, entry.file) };
            if (entry.bucket !== undefined) resolved.bucket = entry.bucket;
            return resolved;
          });
        }
      } catch (e) {
        out.problems.push(`firebase.json: ${errorText(e)}`);
      }
    }
  }
  for (const f of firestoreFiles) {
    try {
      out.firestore.push({ source: rel(absRoot, f), text: readFileSync(f, 'utf8') });
    } catch (e) {
      out.problems.push(`${rel(absRoot, f)}: ${errorText(e)}`);
    }
  }
  for (const f of rtdbFiles) {
    try {
      out.rtdb.push({ source: rel(absRoot, f), json: parseRtdbRulesText(readFileSync(f, 'utf8')) });
    } catch (e) {
      out.problems.push(`${rel(absRoot, f)}: ${errorText(e)}`);
    }
  }
  for (const item of storageEntries) {
    try {
      const loaded: StorageRuleSource = {
        source: rel(absRoot, item.file),
        text: readFileSync(item.file, 'utf8'),
      };
      if (item.bucket !== undefined) loaded.bucket = item.bucket;
      storageList.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  return out;
}
