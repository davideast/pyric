/**
 * Where an app's security rules come from: files named on the command
 * line, the `firestore` and `database` entries of `firebase.json` (single
 * or per-target arrays), and rules the app installs from code. RTDB rules
 * files are read with Pyric's JSON-with-comments reader.
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

export interface RuleSources {
  firestore: FirestoreRuleSource[];
  rtdb: RtdbRuleSource[];
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
  const entries = Array.isArray(section) ? section : [section];
  const out: string[] = [];
  for (const e of entries) {
    const rules = (e as { rules?: unknown } | null)?.rules;
    if (typeof rules === 'string' && !out.includes(rules)) out.push(rules);
  }
  return out;
}

/**
 * Load rules for an app root. Explicit files win; otherwise `firebase.json`
 * is read. Duplicate files (several RTDB targets sharing one file) load once.
 */
export function loadRuleSources(root: string, explicit: { firestore?: string[]; rtdb?: string[] } = {}): RuleSources {
  const absRoot = resolve(root);
  const out: RuleSources = { firestore: [], rtdb: [], problems: [] };
  const hasExplicit = (explicit.firestore?.length ?? 0) > 0 || (explicit.rtdb?.length ?? 0) > 0;
  let firestoreFiles = (explicit.firestore ?? []).map((f) => resolve(f));
  let rtdbFiles = (explicit.rtdb ?? []).map((f) => resolve(f));
  if (!hasExplicit) {
    const config = join(absRoot, 'firebase.json');
    if (existsSync(config)) {
      try {
        const parsed = JSON.parse(readFileSync(config, 'utf8')) as { firestore?: unknown; database?: unknown };
        if (firestoreFiles.length === 0) firestoreFiles = rulesEntries(parsed.firestore).map((f) => join(absRoot, f));
        if (rtdbFiles.length === 0) rtdbFiles = rulesEntries(parsed.database).map((f) => join(absRoot, f));
      } catch (e) {
        out.problems.push(`firebase.json: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  for (const f of firestoreFiles) {
    try {
      out.firestore.push({ source: rel(absRoot, f), text: readFileSync(f, 'utf8') });
    } catch (e) {
      out.problems.push(`${rel(absRoot, f)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const f of rtdbFiles) {
    try {
      out.rtdb.push({ source: rel(absRoot, f), json: parseRtdbRulesText(readFileSync(f, 'utf8')) });
    } catch (e) {
      out.problems.push(`${rel(absRoot, f)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
