/**
 * Disambiguation guard for `pyric sandbox <word...>` (without `--`).
 *
 * Refuses invocations whose first word is another top-level `pyric` command
 * (such as `snapshot` or `serve`), or is not an executable on PATH (suggesting
 * a close sandbox method when one exists), instead of silently launching a
 * sandbox server. Real executables on PATH (`node`, `npm`, `sort`, `test`,
 * `sed`, `vite`) and explicit paths (`./script.sh`) pass through untouched,
 * and `pyric sandbox -- <command...>` always bypasses this guard.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { editDistance } from '../bridge/surface/closest-name.js';
import { TOOL_DESCRIPTIONS } from '../bridge/surface/descriptions.generated.js';
import { TOP_LEVEL_COMMANDS } from './help-catalog.js';
import { SANDBOX_METHOD_WORDS, type ParsedArgs } from './parse-args.js';

const UNSUPPORTED_RUNTIME_WORDS: ReadonlySet<string> = new Set(['bun', 'deno']);

const ALL_SANDBOX_WORDS: readonly string[] = [
  ...SANDBOX_METHOD_WORDS,
  'salvage',
  'seed-from-live',
];

const TOP_LEVEL_PYRIC_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(TOP_LEVEL_COMMANDS),
  'serve',
  ...Object.keys(TOOL_DESCRIPTIONS).filter((name) => name !== 'sandbox'),
]);

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableOnPath(command: string, cwd: string): boolean {
  const dirs: string[] = [join(cwd, 'node_modules', '.bin')];
  const rawPath = process.env.PATH;
  if (rawPath !== undefined && rawPath.length > 0) {
    for (const entry of rawPath.split(delimiter)) {
      if (entry.length > 0) dirs.push(entry);
    }
  }
  for (const dir of dirs) {
    if (isExecutableFile(join(dir, command))) return true;
  }
  return false;
}

function closeSandboxMethod(word: string): string | null {
  const lower = word.toLowerCase();
  for (const candidate of ALL_SANDBOX_WORDS) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ALL_SANDBOX_WORDS) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= 2 && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function formatSandboxAmbiguityError(word: string): string {
  if (TOP_LEVEL_PYRIC_WORDS.has(word)) {
    let suggestionLine = `Did you mean \`pyric ${word}\`?`;
    if (word === 'serve') {
      suggestionLine = 'Did you mean `pyric serve --help` (for `pyric serve <subcommand>`)?';
    }
    return [
      `pyric sandbox: '${word}' is a top-level pyric command, not a sandbox method.`,
      suggestionLine,
      `To run a child executable named '${word}' inside the sandbox, pass \`--\`:`,
      `  pyric sandbox -- ${word}`,
      'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
      '',
    ].join('\n');
  }
  const suggestion = closeSandboxMethod(word);
  if (suggestion !== null) {
    return [
      `pyric sandbox: unknown method '${word}'. Did you mean \`pyric sandbox ${suggestion}\`?`,
      'To run a child command inside the sandbox, pass `--`:',
      `  pyric sandbox -- ${word}`,
      'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
      '',
    ].join('\n');
  }
  return [
    `pyric sandbox: '${word}' is not a sandbox method or an executable on PATH.`,
    'To run a child command inside the sandbox, pass `--`:',
    `  pyric sandbox -- ${word}`,
    'Run `pyric sandbox --help` to list sandbox methods and launcher flags.',
    '',
  ].join('\n');
}

/**
 * Guard `pyric sandbox <word...>` (without `--`) against accidentally launching
 * a sandbox server when `<word>` is another top-level `pyric` command (such as
 * `snapshot`), a mistyped sandbox method, or a nonexistent executable.
 */
export function checkAmbiguousSandboxWord(parsed: ParsedArgs, cwd = process.cwd()): string | null {
  if ((parsed.passthrough?.length ?? 0) > 0) return null;
  const first = parsed.positional[0];
  if (first === undefined) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  if (first.includes('/') || first.includes('\\')) return null;
  if (UNSUPPORTED_RUNTIME_WORDS.has(first)) return null;

  if (TOP_LEVEL_PYRIC_WORDS.has(first)) {
    return formatSandboxAmbiguityError(first);
  }

  if (isExecutableOnPath(first, cwd)) {
    return null;
  }

  return formatSandboxAmbiguityError(first);
}
