/**
 * Tab completion for the terminal. Two modes:
 *
 *   - first-token (no whitespace yet in the input): complete from
 *     built-in slash/colon commands + just-bash command names.
 *   - subsequent token: treat as a path and complete against the
 *     OPFS VFS, resolved relative to the current cwd.
 *
 * Returns either a fully replaced token (single match), a partially
 * advanced token (multi-match with common prefix), or a list of
 * candidates the caller should display.
 */

import { getCommandNames } from 'just-bash';

import { getVFS } from '~/lib/vfs';

export interface CompletionResult {
  /** Replacement for the trailing token of the input. */
  replacement: string;
  /**
   * When > 1 candidates remain after extending to the common prefix,
   * the caller should print this list so the user can disambiguate.
   * Empty when a single match was found and applied.
   */
  candidates: string[];
}

const BUILTIN_COMMANDS = [':help', ':clear', ':history', ':ai', '/ai'];

function lastToken(input: string): { token: string; index: number } {
  const trimmedRight = input;
  let i = trimmedRight.length - 1;
  while (i >= 0 && !/\s/.test(trimmedRight[i]!)) i--;
  return { token: trimmedRight.slice(i + 1), index: i + 1 };
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

async function listVfsDir(absoluteDir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const adapter = getVFS();
    const names = await adapter.promises.readdir(absoluteDir);
    const out: Array<{ name: string; isDir: boolean }> = [];
    for (const name of names) {
      const childPath = absoluteDir.endsWith('/') ? `${absoluteDir}${name}` : `${absoluteDir}/${name}`;
      try {
        const stat = await adapter.promises.lstat(childPath);
        out.push({ name, isDir: stat.isDirectory() });
      } catch {
        out.push({ name, isDir: false });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function resolvePath(base: string, token: string): string {
  if (token.startsWith('/')) return token;
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${left}/${token}`.replace(/\/+/g, '/');
}

function dirAndPrefix(absolutePath: string): { dir: string; prefix: string } {
  if (absolutePath.endsWith('/')) return { dir: absolutePath, prefix: '' };
  const idx = absolutePath.lastIndexOf('/');
  if (idx === -1) return { dir: '/', prefix: absolutePath };
  return { dir: absolutePath.slice(0, idx) || '/', prefix: absolutePath.slice(idx + 1) };
}

/**
 * Complete a single token against the available command set.
 * Non-async — runs synchronously off `getCommandNames()` + the
 * built-in list.
 */
function completeCommandToken(token: string): string[] {
  const all = new Set<string>(BUILTIN_COMMANDS);
  try {
    for (const name of getCommandNames()) all.add(name);
  } catch {
    // older just-bash builds may not export the registry; ignore.
  }
  return [...all].filter((name) => name.startsWith(token)).sort();
}

/**
 * Complete a path token against the OPFS VFS, resolved relative to
 * `cwd`. Returns names (display form), and the absolute matches the
 * caller can use to assemble a replacement that preserves the
 * relative/absolute shape of the original token.
 */
async function completePathToken(
  cwd: string,
  token: string,
): Promise<{ matches: Array<{ name: string; isDir: boolean }>; dirAbsolute: string; prefix: string }> {
  const absolute = resolvePath(cwd, token);
  const { dir, prefix } = dirAndPrefix(absolute);
  const entries = await listVfsDir(dir);
  const matches = entries.filter((e) => e.name.startsWith(prefix));
  return { matches, dirAbsolute: dir, prefix };
}

/**
 * Public entry point. `input` is the current line buffer; `cwd` is
 * the resolved working directory the user is in.
 *
 * Routing rule: if the buffer already contains a complete word
 * before the cursor's token, we're completing an *argument* — go
 * straight to path completion. Only when no command word exists yet
 * do we offer command-name completion. This is more bulletproof
 * than the previous `slice(...).test(/^\s*$/)` regex, which was
 * vulnerable to edge cases where a stray non-printable character
 * before the cursor would still register as "command position" and
 * surface the entire just-bash command registry under `cd s<tab>`.
 */
export async function complete(input: string, cwd: string): Promise<CompletionResult | null> {
  const { token } = lastToken(input);
  const before = leadingWordsBeforeCursor(input);

  if (before.length === 0) {
    // Still on the first word — complete from command names.
    const matches = completeCommandToken(token);
    if (matches.length === 0) return null;
    if (matches.length === 1) {
      return { replacement: `${matches[0]} `, candidates: [] };
    }
    const prefix = commonPrefix(matches);
    if (prefix.length > token.length) {
      return { replacement: prefix, candidates: matches };
    }
    return { replacement: token, candidates: matches };
  }

  // We have at least one full word ahead of the cursor token —
  // user is naming an argument. Path completion against `cwd`.
  const { matches, prefix } = await completePathToken(cwd, token);
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const m = matches[0]!;
    const tail = m.name.slice(prefix.length);
    const replacementSuffix = tail + (m.isDir ? '/' : ' ');
    return { replacement: token + replacementSuffix, candidates: [] };
  }
  const names = matches.map((m) => m.name);
  const longest = commonPrefix(names);
  if (longest.length > prefix.length) {
    const tail = longest.slice(prefix.length);
    return { replacement: token + tail, candidates: names };
  }
  const display = matches.map((m) => (m.isDir ? `${m.name}/` : m.name));
  return { replacement: token, candidates: display };
}

/**
 * Words that are entirely behind the cursor — i.e. the cursor is
 * past the whitespace that follows them. Counts as "behind" only
 * when there's whitespace separating the word from the cursor's
 * trailing token.
 *
 *   ""        → []        first-token position
 *   "cd"      → []        still typing the first word
 *   "cd "     → ["cd"]    one full word, on the second token
 *   "cd s"    → ["cd"]    one full word, building the second token
 *   "cd src/" → ["cd"]    same (the trailing token is "src/")
 */
function leadingWordsBeforeCursor(input: string): string[] {
  // Strip the trailing partial token (anything not whitespace at the
  // end) and any whitespace before it; what remains is everything
  // the user has finished typing ahead of the cursor.
  const head = input.replace(/\s*\S*$/, '');
  if (!head.trim()) return [];
  return head.trim().split(/\s+/);
}
