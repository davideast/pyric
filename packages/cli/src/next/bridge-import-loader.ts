/**
 * Webpack and Turbopack loader for the shadow-app wrappers and production AI
 * SDK closure in `PYRIC_AI_MODE=production` (#1637, ADR 0022 Ruling 7):
 * rewrites the wrapper's own `firebase/app` or `firebase/app-check` import and
 * internal `@firebase/*` imports inside `firebase/{ai,app,app-check}` and the
 * six production AI `@firebase/*` packages to relative paths in the project's
 * own `firebase` install, while leaving application files untouched so direct
 * app imports of `@firebase/*` hit `client-stop`.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  bridgeImportTarget,
  isProductionAiClientSdkFile,
  productionAiScopedTarget,
  PyricNextBridgeError,
  type BridgeImportOptions,
} from './bridge-imports.js';
import { isProductionAiSdkPackage } from '../serve/firebase-module-swap.js';

interface LoaderContext {
  resourcePath: string;
  rootContext?: string;
  getOptions(): BridgeImportOptions;
}

function realFile(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function importOf(specifier: string): RegExp {
  return new RegExp(`(from\\s*)(['"])${specifier.replace(/[/-]/g, '\\$&')}\\2`, 'g');
}

const SCOPED_FIREBASE_IMPORT = /(\bfrom\s*|\bimport\s*)(['"])(@firebase\/[a-z0-9-]+)\2/g;

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
  let rawPath = this.resourcePath;
  if (!isAbsolute(rawPath)) {
    rawPath = resolve(projectRoot(this), rawPath);
  }
  const file = realFile(rawPath);
  const specifier = wrappers[file];
  if (specifier !== undefined) {
    const target = bridgeImportTarget(file, specifier, projectRoot(this));
    const rewritten = source.replace(importOf(specifier), `$1$2${target}$2`);
    if (rewritten === source) {
      throw new PyricNextBridgeError(
        `pyric: production AI mode expected ${file} to import '${specifier}', and found no such import to point at the Firebase SDK.`,
      );
    }
    return rewritten;
  }

  if (!isProductionAiClientSdkFile(file)) {
    return source;
  }
  const root = projectRoot(this);
  return source.replace(SCOPED_FIREBASE_IMPORT, (fullMatch, keyword: string, quote: string, pkgName: string) => {
    if (!isProductionAiSdkPackage(pkgName)) return fullMatch;
    const relativeTarget = productionAiScopedTarget(file, pkgName, root);
    if (relativeTarget === null) return fullMatch;
    return `${keyword}${quote}${relativeTarget}${quote}`;
  });
}
