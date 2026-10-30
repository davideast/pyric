/**
 * Webpack and Turbopack loader for the shadow-app wrappers in production AI
 * mode (#1637): rewrites the wrapper's own `firebase/app` or
 * `firebase/app-check` import to the relative path `bridge-imports.ts`
 * computed, so the bundler's alias for that specifier, which names the
 * wrapper's entry, does not send the wrapper back to itself. A file the
 * options do not name passes through unchanged.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BridgeImportRewrites } from './bridge-imports.js';

interface LoaderContext {
  resourcePath: string;
  rootContext?: string;
  getOptions(): BridgeImportRewrites;
}

function realFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function quoted(specifier: string): RegExp {
  return new RegExp(`(from\\s*)(['"])${specifier.replace(/[/-]/g, '\\$&')}\\2`, 'g');
}

export default function bridgeImportLoader(this: LoaderContext, source: string): string {
  const file = realFile(resolve(this.rootContext ?? process.cwd(), this.resourcePath));
  const rewrite = this.getOptions().rewrites[file];
  if (rewrite === undefined) return source;
  return source.replace(quoted(rewrite.specifier), `$1$2${rewrite.target}$2`);
}
