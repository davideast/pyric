/**
 * `pyric dev` rules wiring — load the project's `firestore.rules`, make it
 * executable for the in-page sandbox, and fail FAST at startup on broken
 * rules (a clear CLI error beats a silently rule-less page).
 *
 * `2+modules` sources are resolved node-side (`resolveModulesBrowser` — pure,
 * stdlib inlined, no disk reads) before embedding, so the page runtime only
 * ever sees plain-v2 source the in-browser evaluator understands. This is the
 * same lesson the playground's write_file learned (a capable model authored
 * correct modular rules that scored 0/5 unresolved — auth-sdk work, PR #525).
 */
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { lintFirestoreRules, resolveModulesBrowser } from 'pyric/rules';
import { parseStorageRules } from 'pyric/storage';
import type { FirebaseJson } from '../cli/firebase-json.js';
import { parseRtdbRulesJson } from '../rtdb/rules-json.js';

export interface LoadedRules {
  /** Plain-v2 source ready for the sandbox, or null when the project has no
   *  rules file configured/present. */
  rules: string | null;
  rulesHash: string | null;
  /** Where it came from (diagnostics + the P3 watcher target). */
  sourcePath: string | null;
}

export interface LoadedStorageRules {
  /** Plain storage-rules source ready for the sandbox, or null when the
   *  project has no storage rules file configured/present. */
  rules: string | null;
  rulesHash: string | null;
  sourcePath: string | null;
}

export interface LoadedDatabaseRules {
  rules: { rules: Record<string, unknown> } | null;
  rulesHash: string | null;
  sourcePath: string | null;
  databaseUrl: string | null;
}

export function rulesHashOf(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

/**
 * Resolve + lint a raw rules source into sandbox-ready plain v2.
 * Throws with an actionable message on unresolvable imports or lint errors.
 */
export function prepareRulesSource(raw: string, sourcePath: string): string {
  let source = raw;
  if (/^\s*rules_version\s*=\s*['"]2\+modules['"]/m.test(raw)) {
    const resolved = resolveModulesBrowser(raw);
    if (!resolved.success) {
      throw new Error(
        `pyric dev: ${sourcePath} uses 2+modules but module resolution failed: ${resolved.error.message}`,
      );
    }
    source = resolved.data.resolved;
  }
  const lint = lintFirestoreRules(source);
  if (lint.parseError) {
    const { line, column } = lint.parseError;
    throw new Error(
      `pyric dev: ${sourcePath} failed to parse (line ${line}, col ${column}) — fix the rules before serving.`,
    );
  }
  const errors = lint.warnings.filter((w) => w.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `pyric dev: ${sourcePath} has ${errors.length} rules error(s):\n` +
        errors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }
  return source;
}

/**
 * Load the project rules per `firebase.json` (`firestore.rules` path,
 * defaulting to `firestore.rules` in cwd when the key is absent but the file
 * exists). Missing file with no explicit config → `{ rules: null }` (serving
 * without rules is fine; the runtime logs it). Missing file that IS
 * explicitly configured → throw (the project says it should exist).
 */
export async function loadProjectRules(
  cwd: string,
  config: FirebaseJson | null,
): Promise<LoadedRules> {
  const configured = config?.firestore?.rules;
  const rel = configured ?? 'firestore.rules';
  const path = isAbsolute(rel) ? rel : join(cwd, rel);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configured) {
        throw new Error(`pyric dev: firebase.json points firestore.rules at ${path}, but it does not exist.`);
      }
      return { rules: null, rulesHash: null, sourcePath: null };
    }
    throw e;
  }
  const rules = prepareRulesSource(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path };
}

/**
 * Validate a raw storage-rules source. `pyric/storage`'s parser throws a
 * plain `SyntaxError` (no line/col like the firestore lint path) — wrap it
 * into the same actionable "fix before serving" message shape.
 */
export function prepareStorageRulesSource(raw: string, sourcePath: string): string {
  try {
    parseStorageRules(raw);
  } catch (e) {
    throw new Error(
      `pyric dev: ${sourcePath} failed to parse: ${e instanceof Error ? e.message : String(e)} — fix the rules before serving.`,
    );
  }
  return raw;
}

/**
 * Load the project's storage rules per `firebase.json` (`storage.rules`
 * path — the block may be a single object or an array of per-bucket
 * entries; v1 has one implicit bucket, so the FIRST entry with a `rules`
 * path wins, defaulting to `storage.rules` in cwd when the block is absent
 * but the file exists). Missing file with no explicit config → `{ rules:
 * null }` (serving without storage rules is fine — same posture as
 * `loadProjectRules`). Missing file that IS explicitly configured → throw
 * (the project says it should exist).
 */
export async function loadProjectStorageRules(
  cwd: string,
  config: FirebaseJson | null,
): Promise<LoadedStorageRules> {
  const block = config?.storage;
  const entries = block ? (Array.isArray(block) ? block : [block]) : [];
  const configured = entries.find((e) => e && typeof e === 'object' && e.rules)?.rules;
  const rel = configured ?? 'storage.rules';
  const path = isAbsolute(rel) ? rel : join(cwd, rel);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configured) {
        throw new Error(`pyric dev: firebase.json points storage.rules at ${path}, but it does not exist.`);
      }
      return { rules: null, rulesHash: null, sourcePath: null };
    }
    throw e;
  }
  const rules = prepareStorageRulesSource(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path };
}

export async function loadProjectDatabaseRules(
  cwd: string,
  config: FirebaseJson | null,
): Promise<LoadedDatabaseRules> {
  const configured = config?.database?.rules;
  if (!configured) {
    return {
      rules: null,
      rulesHash: null,
      sourcePath: null,
      databaseUrl: config?.database?.url ?? null,
    };
  }

  const path = isAbsolute(configured) ? configured : join(cwd, configured);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`pyric dev: firebase.json points database.rules at ${path}, but it does not exist.`);
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`pyric dev: ${path} failed to parse as RTDB rules JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rules = parseRtdbRulesJson(
    parsed,
    () => new Error(`pyric dev: ${path} must contain a top-level "rules" object.`),
  );

  return {
    rules,
    rulesHash: rulesHashOf(raw),
    sourcePath: path,
    databaseUrl: config?.database?.url ?? null,
  };
}

/**
 * Watch the rules file and invoke `onChange` with freshly prepared
 * (resolved + linted) source. Broken intermediate saves are LOGGED and
 * skipped — the last-good ruleset stays live (the write_file lesson:
 * never replace a working ruleset with un-evaluatable source).
 * Debounced; returns the watcher for shutdown.
 */
export function watchProjectRules(
  sourcePath: string,
  onChange: (next: { rules: string; rulesHash: string }) => void,
  onError: (message: string) => void,
  debounceMs = 150,
): FSWatcher {
  return watchRulesFile(sourcePath, prepareRulesSource, onChange, onError, debounceMs);
}

/**
 * Watch a project's storage.rules file, same contract as
 * {@link watchProjectRules} but validating via `pyric/storage`'s parser.
 */
export function watchProjectStorageRules(
  sourcePath: string,
  onChange: (next: { rules: string; rulesHash: string }) => void,
  onError: (message: string) => void,
  debounceMs = 150,
): FSWatcher {
  return watchRulesFile(sourcePath, prepareStorageRulesSource, onChange, onError, debounceMs);
}

/**
 * Shared watch implementation. Broken intermediate saves are LOGGED and
 * skipped — the last-good ruleset stays live (the write_file lesson: never
 * replace a working ruleset with un-evaluatable source). Debounced; returns
 * the watcher for shutdown.
 */
function watchRulesFile(
  sourcePath: string,
  prepare: (raw: string, sourcePath: string) => string,
  onChange: (next: { rules: string; rulesHash: string }) => void,
  onError: (message: string) => void,
  debounceMs: number,
): FSWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(sourcePath, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void readFile(sourcePath, 'utf8').then(
        (raw) => {
          try {
            const rules = prepare(raw, sourcePath);
            onChange({ rules, rulesHash: rulesHashOf(rules) });
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        },
        (e) => onError(e instanceof Error ? e.message : String(e)),
      );
    }, debounceMs);
  });
  // An FSWatcher with no 'error' listener throws at the event-loop level on
  // watcher failure (EMFILE, the watched file renamed away on some platforms)
  // and would kill the serve process. Degrade to "no hot reload" instead.
  watcher.on('error', (e) =>
    onError(`rules watcher failed (hot reload off): ${e instanceof Error ? e.message : String(e)}`),
  );
  return watcher;
}
