/**
 * Verifies that every `@pyric/ui` subpath entry in `dist/` begins with the
 * `'use client'` directive, so a React Server Component importer treats the
 * entry as a client boundary instead of failing on `useState` or `useEffect`.
 *
 * Usage: bun run scripts/check-use-client.ts [packageDir]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** True when the first statement of the module is a `'use client'` directive. */
export function startsWithUseClient(source: string): boolean {
  let rest = source.replace(/^﻿/, '');
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      if (end === -1) return false;
      rest = rest.slice(end + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end === -1) return false;
      rest = rest.slice(end + 2);
    } else {
      break;
    }
  }
  return /^(['"])use client\1\s*(;|\n|$)/.test(rest);
}

/** The `import` targets of the package's `exports` map, as paths relative to the package. */
export function exportedEntries(packageJson: { exports?: Record<string, unknown> }): string[] {
  const entries: string[] = [];
  for (const target of Object.values(packageJson.exports ?? {})) {
    const file = typeof target === 'string' ? target : (target as { import?: unknown }).import;
    if (typeof file === 'string' && /\.[cm]?js$/.test(file)) entries.push(file);
  }
  return entries;
}

/** Entries whose built file does not start with the directive. */
export function entriesMissingUseClient(packageDir: string): string[] {
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return exportedEntries(packageJson).filter((entry) => {
    try {
      return !startsWithUseClient(readFileSync(join(packageDir, entry), 'utf8'));
    } catch {
      return true;
    }
  });
}

if (import.meta.main) {
  const packageDir = resolve(process.argv[2] ?? '.');
  const missing = entriesMissingUseClient(packageDir);
  if (missing.length > 0) {
    console.error(`These entries do not start with 'use client':\n${missing.map((entry) => `  ${entry}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Every subpath entry starts with 'use client'.`);
}
