/**
 * The specifier map behind `@pyric/cli/register`: unmodified Firebase
 * imports resolve to their pyric mirrors. Most subpaths map 1:1
 * (`firebase-admin/app` → `pyric-admin/app`, `firebase/firestore` →
 * `pyric/firestore`, …). `firebase/app` maps to the Node register adapter,
 * which translates FirebaseOptions into the process sandbox before entering
 * the strict `pyric/app` mirror.
 *
 * Under a remote activation (`PYRIC_SANDBOX=remote`, `remote:<url>`, `1` or
 * `true`) the client SDKs that reach the Node host map to its Node client
 * instead (#1082): `firebase/app`, `firebase/database`, `firebase/firestore`,
 * `firebase/auth` and `firebase/storage` resolve to
 * `@pyric/cli/register/client/*`. The other client subpaths keep their pyric
 * mirrors, which refuse there because the app registry has no sandbox.
 *
 * Pure apart from reading the environment — the resolution hooks (index.ts /
 * hooks.ts) call this and the unit suite exercises it directly. Deliberately
 * narrow: only the two package roots match. `@firebase/*` internals,
 * `firebase-functions`, and anything merely *containing* "firebase" pass
 * through untouched.
 *
 * Next 16's Turbopack renames server externals (#1443): it links
 * `.next/node_modules/firebase-admin-<16 hex>` to the installed package and
 * imports `firebase-admin-<hash>/app`. `canonicalFirebaseSpecifier` names such
 * an import by its package, and the hooks map the canonical name only after
 * the renamed import resolved into the real package (`package-identity.ts`).
 */

import { parsePyricSandbox } from 'pyric/sandbox/internal';
import { isBypassedBridgeImport, isProductionAiSdkFile, resolveAiMode, type AiMode } from '../serve/firebase-module-swap.js';

const MAPPINGS: ReadonlyArray<readonly [from: string, to: string]> = [
  // firebase-admin first — `firebase-admin` must never match the bare
  // `firebase` root (it can't today, but the order documents the intent).
  ['firebase-admin', 'pyric-admin'],
  ['firebase', 'pyric'],
];

/** Client SDK subpaths the Node host client serves under a remote activation. */
const NODE_HOST_CLIENT_SUBPATHS = new Set(['database', 'firestore', 'auth', 'storage']);
const NODE_HOST_CLIENT = '@pyric/cli/register/client';
/** Production AI mode: the Firebase App Check SDK on the shadow app `firebase/ai` reads. */
const APP_CHECK_BRIDGE = '@pyric/cli/register/app-bridge-app-check';

export interface MapFirebaseOptions {
  aiMode?: AiMode;
  /** The activator value; defaults to `process.env.PYRIC_SANDBOX`. */
  sandbox?: string;
}

function appTarget(isRemote: boolean, isProductionMode: boolean): string {
  if (isRemote) return isProductionMode ? `${NODE_HOST_CLIENT}/app-bridge` : `${NODE_HOST_CLIENT}/app`;
  return isProductionMode ? '@pyric/cli/register/app-bridge' : 'pyric/app/register';
}

/** `firebase/<subpath>` on the Node host client, or null when it keeps its mirror. */
function nodeHostClientTarget(specifier: string): string | null {
  const isClientSubpath = specifier.startsWith('firebase/');
  if (!isClientSubpath) return null;
  const subpath = specifier.slice('firebase/'.length);
  const servedByHost = NODE_HOST_CLIENT_SUBPATHS.has(subpath);
  return servedByHost ? `${NODE_HOST_CLIENT}/${subpath}` : null;
}

/**
 * A Turbopack-renamed package root: `firebase-admin` or `firebase`, a dash and
 * exactly 16 lowercase hex characters, then the end or a non-empty subpath.
 * Anchored at the start, so `firebase-functions-<hash>`, `@firebase/*` and
 * `my-firebase-<hash>` never match.
 */
const RENAMED_FIREBASE = /^(firebase-admin|firebase)-[0-9a-f]{16}(\/.+)?$/;

/**
 * The canonical name of a Turbopack-renamed Firebase import
 * (`firebase-admin-<hash>/app` → `firebase-admin/app`), or `null` when the
 * specifier isn't one. The name alone proves nothing: the caller confirms the
 * import resolved into the package of that name before mapping it.
 */
export function canonicalFirebaseSpecifier(specifier: string): string | null {
  const match = RENAMED_FIREBASE.exec(specifier);
  if (match === null) return null;
  const [, packageRoot, subpath = ''] = match;
  return `${packageRoot}${subpath}`;
}

export interface RealFirebaseLoad {
  /** The specifier as written, or its canonical name when Turbopack renamed it. */
  specifier: string;
  importer: string | undefined;
  /** The package the resolved file belongs to, `firebase` or `@firebase/*`. */
  packageName: string;
  /** The resolved file's path inside that package; read only for `firebase` in production AI mode. */
  pathInPackage: () => string | null;
  aiMode: AiMode;
}

/**
 * Whether the swap table hands this client SDK load to the real SDK (ADR
 * 0022): one of pyric's shadow modules reaching the `firebase/app` or
 * `firebase/app-check` it wraps, or, in production AI mode, the files of
 * `firebase/ai`, `firebase/app` and `firebase/app-check` and the `@firebase/*`
 * packages they import (`isProductionAiSdkFile`). The stop in
 * `swap-or-stop.ts` allows exactly these, so the swap and the stop cannot
 * disagree.
 */
export function choosesRealFirebase(load: RealFirebaseLoad): boolean {
  if (isBypassedBridgeImport(load.specifier, load.importer, load.aiMode)) return true;
  const isProductionMode = load.aiMode === 'production';
  return isProductionMode && isProductionAiSdkFile(load.packageName, load.pathInPackage);
}

/**
 * Map a Firebase specifier to its pyric mirror, or return `null` when the
 * specifier is not a Firebase package (leave it for the default resolver).
 */
export function mapFirebaseSpecifier(
  specifier: string,
  importer?: string,
  options?: MapFirebaseOptions,
): string | null {
  const isFirebaseAppSpecifier = specifier === 'firebase/app';
  const aiMode = resolveAiMode(options?.aiMode, process.env);
  if (isBypassedBridgeImport(specifier, importer, aiMode)) {
    return null;
  }

  const isProductionMode = aiMode === 'production';
  const isFirebaseAiSpecifier = specifier === 'firebase/ai';
  const isProductionAiPassthrough = isProductionMode && isFirebaseAiSpecifier;
  if (isProductionAiPassthrough) {
    return null;
  }
  const isProductionAppCheck = isProductionMode && specifier === 'firebase/app-check';
  if (isProductionAppCheck) {
    return APP_CHECK_BRIDGE;
  }

  const setting = options?.sandbox ?? process.env.PYRIC_SANDBOX;
  const isRemote = parsePyricSandbox(setting).mode === 'remote';
  if (isFirebaseAppSpecifier) {
    return appTarget(isRemote, isProductionMode);
  }
  const hostClient = isRemote ? nodeHostClientTarget(specifier) : null;
  if (hostClient !== null) {
    return hostClient;
  }

  for (const [from, to] of MAPPINGS) {
    const isExactMatch = specifier === from;
    if (isExactMatch) {
      return to;
    }
    const isSubpathMatch = specifier.startsWith(`${from}/`);
    if (isSubpathMatch) {
      const subpath = specifier.slice(from.length);
      return to + subpath;
    }
  }
  return null;
}
