/**
 * Webpack and Turbopack loader for the shadow-app wrappers in production AI
 * mode (#1637): rewrites the wrapper's own `firebase/app` or
 * `firebase/app-check` import to a relative path to the browser file of the
 * `firebase` the project root resolves, so the bundler's alias for that
 * specifier, which names the wrapper's entry, does not send the wrapper back
 * to itself. A file the options do not name passes through unchanged; a
 * named file whose import cannot be rewritten throws.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { bridgeImportTarget, PyricNextBridgeError, type BridgeImportOptions } from './bridge-imports.js';

interface LoaderContext {
  resourcePath: string;
  rootContext?: string;
  getOptions(): BridgeImportOptions;
}

function realFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function importOf(specifier: string): RegExp {
  return new RegExp(`(from\\s*)(['"])${specifier.replace(/[/-]/g, '\\$&')}\\2`, 'g');
}

function projectRoot(context: LoaderContext): string {
  const root = context.rootContext;
  if (root === undefined || root === '') {
    throw new PyricNextBridgeError(
      `pyric: production AI mode could not rewrite the Firebase SDK import in ${context.resourcePath}: the bundler gave the loader no project root.`,
    );
  }
  return root;
}

export default function bridgeImportLoader(this: LoaderContext, source: string): string {
  const { wrappers } = this.getOptions();
  const path = isAbsolute(this.resourcePath) ? this.resourcePath : resolve(projectRoot(this), this.resourcePath);
  const file = realFile(path);
  const specifier = wrappers[file];
  if (specifier === undefined) return source;
  const target = bridgeImportTarget(file, specifier, projectRoot(this));
  const rewritten = source.replace(importOf(specifier), `$1$2${target}$2`);
  if (rewritten === source) {
    throw new PyricNextBridgeError(
      `pyric: production AI mode expected ${file} to import '${specifier}', and found no such import to point at the Firebase SDK.`,
    );
  }
  return rewritten;
}
