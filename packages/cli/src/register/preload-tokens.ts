/**
 * Preload flag parsing and canonicalization for `NODE_OPTIONS` and `Worker`
 * `execArgv`.
 *
 * Node executes all `--require` / `-r` preloads (first `NODE_OPTIONS`, then
 * CLI / `execArgv`) before any `--import` preload and before evaluating
 * CommonJS `eval: true` worker source. Placing a synchronous `--require`
 * preload for the active register at the front of `NODE_OPTIONS` and `execArgv`
 * (ahead of any caller preloads and ahead of end-of-options `--`) guarantees
 * the active register installs its hooks before caller preloads or hoisted
 * declarations in eval workers can run.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameLocalFile } from './package-identity.js';

const REQUIRE_TWO_TOKEN_FLAGS = new Set(['--require', '-r']);
const IMPORT_TWO_TOKEN_FLAG = '--import';
const ATTACHED_PRELOAD_PREFIXES = ['--import=', '--require=', '-r='] as const;
const PYRIC_REGISTER_PATH_RE =
  /(?:^|[\\/])(?:@pyric[\\/](?:cli|live)|packages[\\/](?:cli|live))[\\/](?:dist|src)[\\/]register(?:[\\/]index|-eval-worker)?\.[cm]?[jt]s(?:[?#].*)?$/;

interface NodeOptionWord {
  readonly value: string;
  readonly raw: string;
}

interface ParsedPreload {
  readonly kind: 'require' | 'import';
  readonly target: string;
  readonly consumed: 1 | 2;
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function isFilesystemPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  );
}

function isLiveRegisterRef(ref: string): boolean {
  return /(?:^|[\\/])(?:@pyric[\\/]live|packages[\\/]live)[\\/]/.test(ref);
}

function ownBareRegisterName(registerUrl: string): string {
  return isLiveRegisterRef(registerUrl) ? '@pyric/live/register' : '@pyric/cli/register';
}

function foreignBareRegisterName(registerUrl: string): string {
  return isLiveRegisterRef(registerUrl) ? '@pyric/cli/register' : '@pyric/live/register';
}

function isForeignRegisterSpecifier(specifier: string, registerUrl: string): boolean {
  if (specifier === foreignBareRegisterName(registerUrl)) return true;
  if (!PYRIC_REGISTER_PATH_RE.test(specifier)) return false;
  return isLiveRegisterRef(specifier) !== isLiveRegisterRef(registerUrl);
}

function matchesSingleRegisterUrl(specifier: string, registerUrl: string): boolean {
  if (specifier === registerUrl || specifier === ownBareRegisterName(registerUrl)) return true;
  if (isSameLocalFile(specifier, registerUrl)) return true;
  if (!registerUrl.startsWith('file:') || !isFilesystemPathSpecifier(specifier)) return false;
  let registerFile: string;
  try {
    registerFile = fileURLToPath(registerUrl);
  } catch {
    return false;
  }
  const candidateFile = resolve(specifier);
  if (candidateFile === registerFile) return true;
  return tryRealpath(candidateFile) === tryRealpath(registerFile);
}

/**
 * Whether a preload target names the same Pyric register as `registerUrl` (or
 * its synchronous counterpart `syncRegisterUrl`), by `file:` URL, OS
 * filesystem path, or matching bare `@pyric/(cli|live)/register`.
 */
export function matchesRegisterSpecifier(
  specifier: string,
  registerUrl: string,
  syncRegisterUrl?: string,
): boolean {
  if (matchesSingleRegisterUrl(specifier, registerUrl)) return true;
  if (syncRegisterUrl !== undefined && syncRegisterUrl !== registerUrl) {
    return matchesSingleRegisterUrl(specifier, syncRegisterUrl);
  }
  return false;
}

/**
 * Formats a `NODE_OPTIONS` argument value, wrapping it in double quotes with
 * `\` and `"` escaped when it contains whitespace, quotes, or backslashes.
 */
export function formatNodeOptionValue(value: string): string {
  if (value.length > 0 && !/[\s"'\\]/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function syncPreloadPath(registerUrl: string, syncRegisterUrl?: string): string | null {
  const candidate = syncRegisterUrl ?? registerUrl;
  if (!candidate.startsWith('file:')) return null;
  // `@pyric/live/dist/register.js` uses top-level await and cannot be loaded via `--require`.
  if (isLiveRegisterRef(candidate) && !candidate.includes('register-eval-worker')) return null;
  try {
    return fileURLToPath(candidate);
  } catch {
    return null;
  }
}

function attachedPreloadSpecifier(token: string): { kind: 'require' | 'import'; target: string } | null {
  for (const prefix of ATTACHED_PRELOAD_PREFIXES) {
    if (token.startsWith(prefix)) {
      const kind = prefix === '--import=' ? 'import' : 'require';
      return { kind, target: token.slice(prefix.length) };
    }
  }
  return null;
}

function parsePreloadAtTokens(tokens: readonly unknown[], index: number): ParsedPreload | null {
  const word = tokens[index];
  if (typeof word !== 'string') return null;
  if (word === IMPORT_TWO_TOKEN_FLAG || REQUIRE_TWO_TOKEN_FLAGS.has(word)) {
    const next = tokens[index + 1];
    if (typeof next !== 'string') return null;
    const kind = word === IMPORT_TWO_TOKEN_FLAG ? 'import' : 'require';
    return { kind, target: next, consumed: 2 };
  }
  const attached = attachedPreloadSpecifier(word);
  if (attached === null) return null;
  return { kind: attached.kind, target: attached.target, consumed: 1 };
}

function parsePreloadAtItems(
  items: ReadonlyArray<{ readonly value: unknown; readonly raw: unknown }>,
  index: number,
): ParsedPreload | null {
  const item = items[index];
  if (item === undefined || typeof item.value !== 'string') return null;
  const word = item.value;
  if (word === IMPORT_TWO_TOKEN_FLAG || REQUIRE_TWO_TOKEN_FLAGS.has(word)) {
    const next = items[index + 1];
    if (next === undefined || typeof next.value !== 'string') return null;
    const kind = word === IMPORT_TWO_TOKEN_FLAG ? 'import' : 'require';
    return { kind, target: next.value, consumed: 2 };
  }
  const attached = attachedPreloadSpecifier(word);
  if (attached === null) return null;
  return { kind: attached.kind, target: attached.target, consumed: 1 };
}

function tokenizeNodeOptions(nodeOptions: string): NodeOptionWord[] {
  const words: NodeOptionWord[] = [];
  let i = 0;
  while (i < nodeOptions.length) {
    while (i < nodeOptions.length && /\s/.test(nodeOptions.charAt(i))) i++;
    if (i >= nodeOptions.length) break;
    const start = i;
    let value = '';
    while (i < nodeOptions.length && !/\s/.test(nodeOptions.charAt(i))) {
      const ch = nodeOptions.charAt(i);
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < nodeOptions.length && nodeOptions.charAt(i) !== quote) {
          if (nodeOptions.charAt(i) === '\\' && i + 1 < nodeOptions.length && quote === '"') {
            i++;
          }
          value += nodeOptions.charAt(i);
          i++;
        }
        if (i < nodeOptions.length) i++;
        continue;
      }
      if (ch === '\\' && i + 1 < nodeOptions.length) {
        value += nodeOptions.charAt(i + 1);
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }
    words.push({ value, raw: nodeOptions.slice(start, i) });
  }
  return words;
}

function matchesNodeOptionPreload(
  nodeOptions: string,
  predicate: (specifier: string) => boolean,
): boolean {
  const tokens = tokenizeNodeOptions(nodeOptions).map((word) => word.value);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break;
    const parsed = parsePreloadAtTokens(tokens, i);
    if (parsed === null) continue;
    if (predicate(parsed.target)) return true;
    i += parsed.consumed - 1;
  }
  return false;
}

/**
 * Whether `nodeOptions` already loads the active Pyric register at `registerUrl`
 * (or `syncRegisterUrl`), via `--import` or `-r`/`--require`.
 */
export function loadsRegister(
  nodeOptions: string,
  registerUrl: string,
  syncRegisterUrl?: string,
): boolean {
  return matchesNodeOptionPreload(nodeOptions, (specifier) =>
    matchesRegisterSpecifier(specifier, registerUrl, syncRegisterUrl),
  );
}

/**
 * Whether `nodeOptions` carries a preload naming the other Pyric register.
 */
export function hasForeignRegisterPreload(nodeOptions: string, registerUrl: string): boolean {
  return matchesNodeOptionPreload(nodeOptions, (specifier) => isForeignRegisterSpecifier(specifier, registerUrl));
}

function firstPyricRegisterKind(tokens: readonly string[], cliRegisterUrl: string): 'cli' | 'live' | null {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break;
    const parsed = parsePreloadAtTokens(tokens, i);
    if (parsed === null) continue;
    i += parsed.consumed - 1;
    if (matchesRegisterSpecifier(parsed.target, cliRegisterUrl)) return 'cli';
    if (isForeignRegisterSpecifier(parsed.target, cliRegisterUrl)) return 'live';
  }
  return null;
}

/**
 * Whether `nodeOptions` or `execArgv` schedules the sandbox register
 * (`cliRegisterUrl`) ahead of any live register preload.
 */
export function hasSandboxRegisterAheadOfLive(
  nodeOptions: string,
  execArgv: readonly string[],
  cliRegisterUrl: string,
): boolean {
  const nodeOptionTokens = tokenizeNodeOptions(nodeOptions).map((word) => word.value);
  const nodeOptionKind = firstPyricRegisterKind(nodeOptionTokens, cliRegisterUrl);
  if (nodeOptionKind !== null) return nodeOptionKind === 'cli';
  return firstPyricRegisterKind(execArgv, cliRegisterUrl) === 'cli';
}

/**
 * Whether `tokens` (up to `--`) schedules another preload that Node will run
 * before the active register. Accounts for Node's two-phase preload order where
 * all `--require`/`-r` flags execute before any `--import` flag.
 */
export function hasPreloadBeforeRegisterTokens(
  tokens: readonly unknown[],
  registerUrl: string,
  syncRegisterUrl?: string,
): boolean {
  let sawOwnRequire = false;
  let sawOtherRequire = false;
  let sawOwnImport = false;
  let sawOtherImport = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break;
    const parsed = parsePreloadAtTokens(tokens, i);
    if (parsed === null) continue;
    i += parsed.consumed - 1;
    const isOwn = matchesRegisterSpecifier(parsed.target, registerUrl, syncRegisterUrl);
    if (parsed.kind === 'require') {
      if (isOwn) {
        sawOwnRequire = true;
      } else if (!sawOwnRequire) {
        sawOtherRequire = true;
      }
      continue;
    }
    if (isOwn) {
      sawOwnImport = true;
    } else if (!sawOwnRequire && !sawOwnImport) {
      sawOtherImport = true;
    }
  }
  return sawOtherRequire || (!sawOwnRequire && sawOtherImport);
}

/**
 * Whether `nodeOptions` schedules another preload that executes ahead of the
 * active register.
 */
export function hasPreloadBeforeRegister(
  nodeOptions: string,
  registerUrl: string,
  syncRegisterUrl?: string,
): boolean {
  const tokens = tokenizeNodeOptions(nodeOptions).map((word) => word.value);
  return hasPreloadBeforeRegisterTokens(tokens, registerUrl, syncRegisterUrl);
}

/**
 * Whether `execArgv` (before `--`) loads the active register via a non-canonical
 * specifier (such as a bare package name or relative path).
 */
export function hasNonFileUrlRegisterExecArgv(
  execArgv: readonly string[],
  registerUrl: string,
  syncRegisterUrl?: string,
): boolean {
  const canonicalSyncPath = syncPreloadPath(registerUrl, syncRegisterUrl);
  for (let i = 0; i < execArgv.length; i++) {
    if (execArgv[i] === '--') break;
    const parsed = parsePreloadAtTokens(execArgv, i);
    if (parsed === null) continue;
    i += parsed.consumed - 1;
    if (!matchesRegisterSpecifier(parsed.target, registerUrl, syncRegisterUrl)) continue;
    const isCanonicalRequire =
      parsed.kind === 'require' && canonicalSyncPath !== null && parsed.target === canonicalSyncPath;
    const isCanonicalImport = parsed.kind === 'import' && parsed.target === registerUrl;
    if (!isCanonicalRequire && !isCanonicalImport) return true;
  }
  return false;
}

function canonicalPreloadTokens(
  registerUrl: string,
  syncRegisterUrl: string | undefined,
  quoteForNodeOptions: boolean,
): string[] {
  const syncPath = syncPreloadPath(registerUrl, syncRegisterUrl);
  if (syncPath === null) {
    return ['--import', registerUrl];
  }
  const formattedSync = quoteForNodeOptions ? formatNodeOptionValue(syncPath) : syncPath;
  if (syncRegisterUrl !== undefined && syncRegisterUrl !== registerUrl) {
    return ['--require', formattedSync];
  }
  return ['--require', formattedSync, '--import', registerUrl];
}

function stripOwnRegisterPreloads(
  items: ReadonlyArray<{ readonly value: unknown; readonly raw: unknown }>,
  registerUrl: string,
  syncRegisterUrl?: string,
): unknown[] {
  const rest: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.value === '--') {
      for (let j = i; j < items.length; j++) {
        const tail = items[j];
        if (tail !== undefined) rest.push(tail.raw);
      }
      break;
    }
    const parsed = parsePreloadAtItems(items, i);
    if (parsed !== null && matchesRegisterSpecifier(parsed.target, registerUrl, syncRegisterUrl)) {
      i += parsed.consumed - 1;
      continue;
    }
    if (parsed !== null) {
      rest.push(item.raw);
      if (parsed.consumed === 2) {
        const nextItem = items[i + 1];
        if (nextItem !== undefined) rest.push(nextItem.raw);
        i++;
      }
      continue;
    }
    rest.push(item.raw);
  }
  return rest;
}

/**
 * Ensure `nodeOptions` loads the active register via its canonical synchronous
 * `--require` preload (plus `--import` when `syncRegisterUrl` equals
 * `registerUrl`) at the very front, ahead of any caller or foreign preload and
 * ahead of `--`, deduplicating any existing own-register preloads.
 */
export function withCanonicalRegisterNodeOptions(
  nodeOptions: string,
  registerUrl: string,
  syncRegisterUrl?: string,
): string {
  const canonical = canonicalPreloadTokens(registerUrl, syncRegisterUrl, true);
  const words = tokenizeNodeOptions(nodeOptions);
  if (words.length === 0) return canonical.join(' ');
  const rest = stripOwnRegisterPreloads(words, registerUrl, syncRegisterUrl) as string[];
  return [...canonical, ...rest].join(' ');
}

/**
 * Ensure a `Worker` `execArgv` array loads the active register via its
 * canonical synchronous `--require` preload at index 0, ahead of any caller
 * preload and ahead of `--`, deduplicating own-register preloads before `--`
 * and leaving `--` and everything after it untouched.
 */
export function withCanonicalRegisterExecArgv(
  execArgv: readonly unknown[],
  registerUrl: string,
  syncRegisterUrl?: string,
): unknown[] {
  const canonical = canonicalPreloadTokens(registerUrl, syncRegisterUrl, false);
  const items = execArgv.map((entry) => ({ value: entry, raw: entry }));
  const rest = stripOwnRegisterPreloads(items, registerUrl, syncRegisterUrl);
  return [...canonical, ...rest];
}
