/**
 * Detect a served frontend build that inlined the real Firebase SDK.
 *
 * The served import map remaps only bare `firebase/*` specifiers, so a plain
 * `vite build` that compiled the SDK into an app chunk cannot be sandboxed:
 * its calls reach real Google endpoints while the injected banner claims
 * otherwise. `cli/serve.ts` refuses such a dist rather than serving it.
 *
 * Only the SDK fingerprint hosts are matched, never the full endpoint catalog.
 * This check throws, and a dist can legitimately carry a bare callable URL, a
 * public asset URL, or a `databaseURL` literal without any Firebase SDK in it.
 *
 * Backend bundles are deliberately out of scope. `withPyric` externalizes
 * firebase and firebase-admin, the backend-bundler docs tell users to mark them
 * external, and module-level swap-or-stop enforces server imports at runtime.
 */
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { SDK_FINGERPRINT_HOSTS } from '../google-endpoints.js';

/** Default directory depth limit for the walk (covers Next/Astro/SvelteKit nested route chunks). */
const DEFAULT_MAX_DEPTH = 16;

/** Default total script and HTML files read before stopping early with a warning. */
const DEFAULT_MAX_FILES = 1_000;

/** Extra directory stats allowed after `maxFiles` is reached to confirm unscanned files exist. */
const MAX_POST_LIMIT_DIR_CHECKS = 64;

/** Script extensions worth reading in served frontend output. */
const SCRIPT_FILE = /\.(js|mjs)$/i;

/** HTML documents whose inline `<script>` blocks can carry a single-file bundle. */
const HTML_FILE = /\.(html|htm)$/i;

/** HTML `<script>` elements; attributes and body are inspected per tag. */
const INLINE_SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const EXECUTABLE_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

function isAsciiWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isAttrNameChar(ch: string): boolean {
  return (
    ch !== '' &&
    !isAsciiWhitespace(ch) &&
    ch !== '=' &&
    ch !== '>' &&
    ch !== '/' &&
    ch !== '"' &&
    ch !== "'"
  );
}

/**
 * Parse opening `<script ...>` attributes into a lowercase name -> value map
 * so `data-src`, `data-type`, or quoted attribute values containing `src=`
 * never alias real `src` or `type` attributes.
 */
function parseScriptTagAttributes(raw: string): ReadonlyMap<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  const len = raw.length;

  while (i < len) {
    while (i < len && (isAsciiWhitespace(raw[i] ?? '') || raw[i] === '/')) {
      i += 1;
    }
    if (i >= len) break;

    const nameStart = i;
    while (i < len && isAttrNameChar(raw[i] ?? '')) {
      i += 1;
    }
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const name = raw.slice(nameStart, i).toLowerCase();

    while (i < len && isAsciiWhitespace(raw[i] ?? '')) {
      i += 1;
    }
    let value = '';
    if (raw[i] === '=') {
      i += 1;
      while (i < len && isAsciiWhitespace(raw[i] ?? '')) {
        i += 1;
      }
      const quote = raw[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const valStart = i;
        while (i < len && raw[i] !== quote) {
          i += 1;
        }
        value = raw.slice(valStart, i);
        if (raw[i] === quote) i += 1;
      } else {
        const valStart = i;
        while (i < len && !isAsciiWhitespace(raw[i] ?? '') && raw[i] !== '>') {
          i += 1;
        }
        value = raw.slice(valStart, i);
      }
    }
    if (!attrs.has(name)) {
      attrs.set(name, value);
    }
  }
  return attrs;
}

const EXPECTED_FS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'ELOOP',
]);

function isExpectedFsScanError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && EXPECTED_FS_ERROR_CODES.has(code);
}

function readSortedDirectory(dir: string): string[] | null {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (isExpectedFsScanError(error)) return null;
    throw error;
  }
}

function statEntryQuietly(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if (isExpectedFsScanError(error)) return null;
    throw error;
  }
}

function readTextQuietly(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isExpectedFsScanError(error)) return null;
    throw error;
  }
}

function containsSdkFingerprint(text: string): boolean {
  return SDK_FINGERPRINT_HOSTS.some((host) => text.includes(host));
}

function isExecutableInlineScriptTag(rawAttributes: string): boolean {
  const attributes = parseScriptTagAttributes(rawAttributes);
  if (attributes.has('src')) {
    return false;
  }
  const rawType = attributes.get('type');
  if (rawType === undefined) {
    return true;
  }
  const essence = (rawType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return EXECUTABLE_SCRIPT_TYPES.has(essence);
}

function hasInlinedSdkInHtml(html: string): boolean {
  for (const match of html.matchAll(INLINE_SCRIPT_TAG)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (!isExecutableInlineScriptTag(attributes)) continue;
    if (containsSdkFingerprint(body)) return true;
  }
  return false;
}

function formatScanLimitWarning(
  publicDirLabel: string,
  scannedFiles: number,
  maxFiles: number,
  maxDepth: number,
  stoppedAtFileLimit: boolean,
  stoppedAtDepthLimit: boolean,
): string | null {
  if (!stoppedAtFileLimit && !stoppedAtDepthLimit) {
    return null;
  }
  let reason: string;
  if (stoppedAtFileLimit && stoppedAtDepthLimit) {
    reason = `file limit (${maxFiles} files) and directory depth limit (depth ${maxDepth})`;
  } else if (stoppedAtFileLimit) {
    reason = `file limit (${maxFiles} files)`;
  } else {
    reason = `directory depth limit (depth ${maxDepth})`;
  }
  return (
    `  warning: inlined-SDK scan of ${publicDirLabel} stopped early at its ${reason} ` +
    `after checking ${scannedFiles} file(s); remaining assets were not checked for bundled Firebase SDK hosts.`
  );
}

/**
 * Scan `dir` for inlined SDK fingerprints (`.js`, `.mjs`, and inline `<script>`
 * blocks in `.html`/`.htm`) and return the offending paths relative to `dir`.
 * Calls `options.onWarning` when the scan stops early at `maxFiles` or `maxDepth`.
 */
export function scanForInlinedFirebase(
  dir: string,
  options: {
    maxDepth?: number;
    maxFiles?: number;
    publicDirLabel?: string;
    onWarning?: (warning: string) => void;
  } = {},
): string[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const hits: string[] = [];
  let scannedFiles = 0;
  let stoppedAtDepthLimit = false;
  let stoppedAtFileLimit = false;
  let postLimitDirChecks = 0;

  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > maxDepth) {
      stoppedAtDepthLimit = true;
      return;
    }
    if (scannedFiles >= maxFiles && stoppedAtFileLimit) {
      return;
    }
    const names = readSortedDirectory(current);
    if (names === null) return;

    for (const name of names) {
      if (scannedFiles >= maxFiles && stoppedAtFileLimit) {
        return;
      }
      const path = join(current, name);
      const relPath = rel.length > 0 ? `${rel}/${name}` : name;
      const stat = statEntryQuietly(path);
      if (stat === null) continue;

      if (stat.isDirectory()) {
        // The pyric namespace itself never lands in hosting.public, and a
        // node_modules or dot-directory (.next, .git, .pyric) is not served output.
        if (name === 'node_modules' || name.startsWith('.')) continue;
        if (depth >= maxDepth) {
          stoppedAtDepthLimit = true;
          continue;
        }
        if (scannedFiles >= maxFiles) {
          postLimitDirChecks += 1;
          if (postLimitDirChecks > MAX_POST_LIMIT_DIR_CHECKS) {
            stoppedAtFileLimit = true;
            return;
          }
        }
        walk(path, relPath, depth + 1);
        continue;
      }

      const isScript = SCRIPT_FILE.test(name);
      const isHtml = !isScript && HTML_FILE.test(name);
      if (!isScript && !isHtml) continue;

      if (scannedFiles >= maxFiles) {
        stoppedAtFileLimit = true;
        return;
      }
      scannedFiles += 1;
      const text = readTextQuietly(path);
      if (text === null) continue;
      const matches = isScript ? containsSdkFingerprint(text) : hasInlinedSdkInHtml(text);
      if (matches) {
        hits.push(relPath);
      }
    }
  };

  walk(dir, '', 0);

  if (options.onWarning !== undefined) {
    const label = options.publicDirLabel ?? 'hosting.public';
    const warning = formatScanLimitWarning(
      label,
      scannedFiles,
      maxFiles,
      maxDepth,
      stoppedAtFileLimit,
      stoppedAtDepthLimit,
    );
    if (warning !== null) {
      options.onWarning(warning);
    }
  }
  return hits;
}
