/**
 * Node-only directory walker. Reads every regular file under
 * `localDir` recursively and returns `{ path, bytes }` entries with
 * Hosting-shaped paths (leading `/`, forward slashes).
 *
 * `ignore` takes firebase.json hosting `ignore` globs. Semantics
 * mirror firebase-tools' walker (`glob.sync('**\/*', { dot: true,
 * ignore, nodir: true })`, clones/firebase-tools/src/listFiles.ts:3-11):
 *   - patterns match the POSIX-relative path (no leading `/`);
 *   - dotfiles are matched by `*`/`**` (glob's ignore is always
 *     dot-mode);
 *   - ignore FILTERS results — it does not prune traversal, so
 *     `**\/.*` excludes `.env` but NOT `.git/config` (the last
 *     segment isn't a dotfile). Verified against glob@10 (the version
 *     firebase-tools pins); only patterns ending in `/**` prune a
 *     directory's children, matching glob's `childrenIgnored`.
 *
 * Supported glob subset: `**`, `*`, `?`, `{a,b}` (no character
 * classes / extglobs — no new dependency).
 *
 * Imports `node:*` and is therefore NOT browser-safe — wired only
 * from the Node adapter (`namespaces.ts`), never from `core.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

export interface WalkedFile {
  /** Hosting path: leading `/`, forward slashes. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Globs every deploy ignores, before user config — firebase-tools
 * hard-codes these in its walker (listFiles.ts:8).
 */
export const BASE_IGNORE_GLOBS = [
  '**/firebase-debug.log',
  '**/firebase-debug.*.log',
  '.firebase/*',
];

/**
 * Default `ignore` applied when firebase.json doesn't set one —
 * firebase-tools writes exactly this list into every scaffolded
 * firebase.json (clones/firebase-tools/src/init/features/hosting/
 * index.ts:20 `DEFAULT_IGNORES`).
 */
export const DEFAULT_IGNORE_GLOBS = ['firebase.json', '**/.*', '**/node_modules/**'];

export function walkDir(localDir: string, ignore?: string[]): WalkedFile[] {
  const matcher = compileIgnoreGlobs([...BASE_IGNORE_GLOBS, ...(ignore ?? DEFAULT_IGNORE_GLOBS)]);
  const out: WalkedFile[] = [];
  walk(localDir, localDir, out, matcher);
  return out;
}

function walk(root: string, dir: string, out: WalkedFile[], matcher: IgnoreMatcher): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const rel = relative(root, full);
    const posixRel = sep === posix.sep ? rel : rel.split(sep).join(posix.sep);
    if (entry.isDirectory()) {
      if (!matcher.ignoresChildren(posixRel)) walk(root, full, out, matcher);
      continue;
    }
    if (!entry.isFile()) {
      // Defensive: skip non-regular files (sockets, FIFOs, devices).
      // Some platforms hand back `Unknown` from readdir.
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
    }
    if (matcher.ignoresFile(posixRel)) continue;
    out.push({
      path: '/' + posixRel,
      bytes: new Uint8Array(readFileSync(full)),
    });
  }
}

// ─── ignore-glob matcher ─────────────────────────────────────────────

export interface IgnoreMatcher {
  /** True when a file's relative POSIX path matches any ignore glob. */
  ignoresFile(relPath: string): boolean;
  /**
   * True when an entire directory subtree can be skipped — only
   * patterns ending in `/**` qualify (glob's `childrenIgnored`);
   * plain patterns filter files without pruning the walk.
   */
  ignoresChildren(relDir: string): boolean;
}

/** Compile ignore globs into a matcher. Exported for tests. */
export function compileIgnoreGlobs(patterns: string[]): IgnoreMatcher {
  const fileRes: RegExp[] = [];
  const childrenRes: RegExp[] = [];
  for (const raw of patterns) {
    for (const pattern of expandBraces(raw)) {
      fileRes.push(globToRegExp(pattern));
      if (pattern.endsWith('/**')) {
        childrenRes.push(globToRegExp(pattern.slice(0, -3)));
      }
    }
  }
  return {
    ignoresFile: (relPath) => fileRes.some((re) => re.test(relPath)),
    ignoresChildren: (relDir) => childrenRes.some((re) => re.test(relDir)),
  };
}

/**
 * Expand `{a,b}` alternations (nesting supported) into plain globs.
 * `{}`-free patterns pass through unchanged.
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return [pattern]; // unbalanced — treat literally
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const options: string[] = [];
  let level = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (i === body.length || (ch === ',' && level === 0)) {
      options.push(body.slice(start, i));
      start = i + 1;
    } else if (ch === '{') level++;
    else if (ch === '}') level--;
  }
  return options.flatMap((opt) => expandBraces(head + opt + tail));
}

/**
 * Translate one (brace-free) glob to a RegExp over a relative POSIX
 * path. Dot-mode: `*` / `**` match dotfiles, exactly like glob's
 * always-dot ignore handling.
 */
function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split('/');
  let re = '^';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === '**') {
      // Zero or more whole segments; as the final segment, anything.
      re += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    let segRe = '';
    for (const ch of seg) {
      if (ch === '*') segRe += '[^/]*';
      else if (ch === '?') segRe += '[^/]';
      else segRe += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    re += segRe + (last ? '' : '/');
  }
  return new RegExp(re + '$');
}
