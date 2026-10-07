/**
 * Detection of Next.js Edge runtime files. The Edge runtime has no Node.js
 * module loader, so the `@pyric/cli/register` interception that serves
 * firebase and firebase-admin in the sandbox does not run there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SOURCE_ROOTS = ['app', 'pages', 'src/app', 'src/pages'];
const MIDDLEWARE_FILES = ['middleware', 'src/middleware', 'proxy', 'src/proxy'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', '.git']);

const EDGE_EXPORT = /export\s+const\s+runtime\s*=\s*['"](?:experimental-)?edge['"]/;
const NODE_MIDDLEWARE = /runtime\s*:\s*['"]nodejs['"]/;

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

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * List the project files that run on the Next.js Edge runtime, as paths
 * relative to `projectRoot`: files that export `runtime = 'edge'`, and the
 * middleware file unless it sets `runtime: 'nodejs'`.
 */
export function findEdgeRuntimeFiles(projectRoot: string): string[] {
  if (!existsSync(projectRoot)) {
    return [];
  }
  const edgeFiles: string[] = [];

  const sources: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    collectSourceFiles(join(projectRoot, sourceRoot), sources);
  }
  for (const file of sources) {
    try {
      if (EDGE_EXPORT.test(readFileSync(file, 'utf8'))) {
        edgeFiles.push(toPosix(relative(projectRoot, file)));
      }
    } catch {
      // An unreadable file is not reported.
    }
  }

  for (const base of MIDDLEWARE_FILES) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = join(projectRoot, `${base}${extension}`);
      if (!existsSync(file)) continue;
      try {
        if (!NODE_MIDDLEWARE.test(readFileSync(file, 'utf8'))) {
          edgeFiles.push(toPosix(relative(projectRoot, file)));
        }
      } catch {
        // An unreadable file is not reported.
      }
    }
  }

  return edgeFiles;
}

/** Build the startup warning for the given Edge files, or null when there are none. */
export function formatEdgeRuntimeWarning(edgeFiles: string[]): string | null {
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
