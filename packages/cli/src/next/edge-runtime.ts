/**
 * Detection of Next.js Edge runtime files. The Edge runtime has no Node.js
 * module loader, so the `@pyric/cli/register` interception that serves
 * firebase and firebase-admin in the sandbox does not run there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  createModuleRuntimeResolver,
  SOURCE_EXTENSIONS,
  type ResolvedModuleRuntime,
} from './edge-runtime-ast.js';

const SOURCE_ROOTS = ['app', 'pages', 'src/app', 'src/pages'];
const PROXY_FILES = ['proxy', 'src/proxy'];
const MIDDLEWARE_FILES = ['middleware', 'src/middleware'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', '.git']);

function isEdgeModuleRuntime(resolved: ResolvedModuleRuntime): boolean {
  if (resolved.runtime !== undefined) return resolved.runtime === 'edge';
  return resolved.configRuntime === 'edge';
}

function isNodeModuleRuntime(resolved: ResolvedModuleRuntime): boolean {
  if (resolved.runtime !== undefined) return resolved.runtime === 'nodejs';
  return resolved.configRuntime === 'nodejs';
}

function hasSourceExtension(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function collectSourceFiles(directory: string, found: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const full = join(directory, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      collectSourceFiles(full, found);
    } else if (hasSourceExtension(name)) {
      found.push(full);
    }
  }
}

function toPosix(filePath: string): string {
  if (sep === '/') return filePath;
  return filePath.split(sep).join('/');
}

/**
 * List the project files that run on the Next.js Edge runtime, as paths
 * relative to `projectRoot`: route/page/proxy files that declare
 * `export const runtime = 'edge'` or `export const config = { runtime: 'edge' }`,
 * and `middleware` / `src/middleware` files unless they opt into Node via
 * `export const runtime = 'nodejs'` or `export const config = { runtime: 'nodejs' }`.
 */
export function findEdgeRuntimeFiles(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) {
    return [];
  }
  const edgeFiles: string[] = [];
  const resolveRuntime = createModuleRuntimeResolver(projectRoot);

  const sources: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    collectSourceFiles(join(projectRoot, sourceRoot), sources);
  }
  for (const base of PROXY_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (existsSync(file)) sources.push(file);
    }
  }
  for (const file of sources) {
    if (isEdgeModuleRuntime(resolveRuntime(file))) {
      edgeFiles.push(toPosix(relative(projectRoot, file)));
    }
  }

  for (const base of MIDDLEWARE_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (!existsSync(file)) continue;
      let readable = true;
      try {
        readFileSync(file, 'utf8');
      } catch {
        readable = false;
      }
      if (!readable) continue;
      if (!isNodeModuleRuntime(resolveRuntime(file))) {
        edgeFiles.push(toPosix(relative(projectRoot, file)));
      }
    }
  }

  return edgeFiles;
}

const EDGE_RUNTIME_UNSUPPORTED_CODE = 'PYRIC_EDGE_RUNTIME_UNSUPPORTED';

/** Build the startup warning for the given Edge files, or null when there are none. */
function formatEdgeRuntimeWarning(edgeFiles: string[]): string | null {
  if (edgeFiles.length === 0) {
    return null;
  }
  const list = edgeFiles.map((file) => `  ${file}`).join('\n');
  return (
    '[Pyric] These files run on the Next.js Edge runtime, where the Pyric sandbox does not apply:\n' +
    `${list}\n` +
    'The Edge runtime has no Node.js module loader, so firebase and firebase-admin imports there reach production Firebase.\n' +
    "Move the file to the Node.js runtime (`export const runtime = 'nodejs'`) to use the sandbox."
  );
}

/** Build the stop message for the given Edge files, or null when there are none. */
function formatEdgeRuntimeStop(edgeFiles: string[]): string | null {
  if (edgeFiles.length === 0) {
    return null;
  }
  const list = edgeFiles.map((file) => `  ${file}`).join('\n');
  return (
    '[Pyric] Next.js Edge runtime is not supported in the Pyric sandbox:\n' +
    `${list}\n` +
    'The Edge runtime has no Node.js module.registerHooks, so firebase and firebase-admin imports cannot be swapped or stopped and would reach live Firebase.\n' +
    "Set `export const runtime = 'nodejs'` (or `export const config = { runtime: 'nodejs' }` in middleware), or set `PYRIC_ALLOW_UNSWAPPED_EDGE=1` to bypass this stop at your own risk.\n" +
    `code: ${EDGE_RUNTIME_UNSUPPORTED_CODE}`
  );
}

/**
 * Refuse Next.js Edge runtime files in sandbox dev mode unless explicitly
 * bypassed with `PYRIC_ALLOW_UNSWAPPED_EDGE=1`.
 */
export function enforceNoEdgeRuntime(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): void {
  const edgeFiles = findEdgeRuntimeFiles(projectRoot);
  if (edgeFiles.length === 0) {
    return;
  }
  if (env.PYRIC_ALLOW_UNSWAPPED_EDGE === '1') {
    warn(formatEdgeRuntimeWarning(edgeFiles)!);
    return;
  }
  const error = new Error(formatEdgeRuntimeStop(edgeFiles)!) as Error & { code: string };
  error.code = EDGE_RUNTIME_UNSUPPORTED_CODE;
  throw error;
}
