/**
 * `pyric serve` rules wiring — load the project's `firestore.rules`, make it
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
import type { FirebaseJson } from '../cli/firebase-json.js';

export interface LoadedRules {
  /** Plain-v2 source ready for the sandbox, or null when the project has no
   *  rules file configured/present. */
  rules: string | null;
  rulesHash: string | null;
  /** Where it came from (diagnostics + the P3 watcher target). */
  sourcePath: string | null;
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
        `pyric serve: ${sourcePath} uses 2+modules but module resolution failed: ${resolved.error.message}`,
      );
    }
    source = resolved.data.resolved;
  }
  const lint = lintFirestoreRules(source);
  if (lint.parseError) {
    const { line, column } = lint.parseError;
    throw new Error(
      `pyric serve: ${sourcePath} failed to parse (line ${line}, col ${column}) — fix the rules before serving.`,
    );
  }
  const errors = lint.warnings.filter((w) => w.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `pyric serve: ${sourcePath} has ${errors.length} rules error(s):\n` +
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
        throw new Error(`pyric serve: firebase.json points firestore.rules at ${path}, but it does not exist.`);
      }
      return { rules: null, rulesHash: null, sourcePath: null };
    }
    throw e;
  }
  const rules = prepareRulesSource(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path };
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  return watch(sourcePath, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void readFile(sourcePath, 'utf8').then(
        (raw) => {
          try {
            const rules = prepareRulesSource(raw, sourcePath);
            onChange({ rules, rulesHash: rulesHashOf(rules) });
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        },
        (e) => onError(e instanceof Error ? e.message : String(e)),
      );
    }, debounceMs);
  });
}
