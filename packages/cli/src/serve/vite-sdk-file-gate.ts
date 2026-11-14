import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiMode, ServedFirebaseSpecifier } from './firebase-module-swap.js';
import {
  ROW_MODULE_IDS,
  passThroughSdkPackages,
  realFileUrlOf,
  type SuppliedRows,
} from './vite-supplied-rows.js';
import { STOP_PREFIX, unaliasedSpecifier } from './vite-ssr-routing.js';
import { stopFor, suppliedRowsStopFor } from '../register/swap-or-stop.js';
import { packageNameOf, pathInPackageOf } from '../register/package-identity.js';
import type { SwapResolveContext } from './vite-module-swap.js';

export const DIRECT_SDK_STOP_SPECIFIER = /^(?:firebase|firebase-admin(?:\/.+)?|@firebase\/[^/]+(?:\/.+)?)$/;

export interface StopEntry {
  readonly error: Error;
  readonly specifier: string;
  readonly resolveDir: string;
}

export interface ViteSdkFileGateInput {
  readonly stops: Map<string, StopEntry>;
  readonly allowedUrls: Set<string>;
  readonly aiMode: () => AiMode;
  readonly isOurCode: (importer: string | undefined) => boolean;
  readonly isBypassedBridgeImport: (bare: string, importer: string | undefined) => boolean;
}

function splitBareSpecifier(source: string): string {
  const queryIndex = source.indexOf('?');
  if (queryIndex === -1) return source;
  return source.slice(0, queryIndex);
}

function toImporterUrl(importer: string | undefined): string | undefined {
  if (importer === undefined) return undefined;
  return realFileUrlOf(importer) ?? importer;
}

/** The row specifier a row module id serves, or null for any other importer. */
function rowSpecifierOf(importer: string | undefined): string | null {
  for (const [specifier, id] of ROW_MODULE_IDS) {
    if (id === importer) return specifier;
  }
  return null;
}

/**
 * Whether `url` is the entry of a passed-through specifier, imported by its
 * name: a file of the `firebase` package under that specifier's own folder
 * (`firebase/database` -> `database/dist/`), so no alias can send the name
 * to another service's entry.
 */
function isPassThroughEntry(supplied: SuppliedRows, specifier: string, url: string): boolean {
  const isListed = supplied.passThrough.has(specifier as ServedFirebaseSpecifier);
  if (!isListed || packageNameOf(url) !== 'firebase') return false;
  const folder = `${specifier.slice('firebase/'.length)}/dist/`;
  return pathInPackageOf(url, 'firebase')?.startsWith(folder) ?? false;
}

/**
 * Whether an SDK file the rows or a pass-through already loaded imports a
 * file of a package only a passed-through entry needs (`@firebase/database`,
 * `@firebase/installations`), its own relative imports included.
 */
function isPassThroughPackageFile(
  supplied: SuppliedRows,
  importerUrl: string | undefined,
  url: string,
): boolean {
  const isFromLoadedFile = importerUrl !== undefined && supplied.liveSdkUrls.has(importerUrl);
  if (!isFromLoadedFile) return false;
  const name = packageNameOf(url);
  return name !== null && passThroughSdkPackages(supplied.passThrough).has(name);
}

/**
 * Resolved-file Swap-or-Stop gate for Vite client resolutions in both sandbox
 * and supplied-rows (`@pyric/live`) modes.
 */
export function createViteSdkFileGate(input: ViteSdkFileGateInput) {
  const { stops, allowedUrls, aiMode, isOurCode, isBypassedBridgeImport } = input;

  function refusedFileIdFor(specifier: string, file: string, error: Error): string {
    const id = `${STOP_PREFIX}refused:page-file:${JSON.stringify([specifier, file])}`;
    if (!stops.has(id)) {
      stops.set(id, { error, specifier: file, resolveDir: path.dirname(file) });
    }
    return id;
  }

  function stoppedSandboxFileIdFor(specifier: string, file: string, error: Error): string {
    const id = `${STOP_PREFIX}file:${JSON.stringify([specifier, file])}`;
    if (!stops.has(id)) {
      stops.set(id, { error, specifier: file, resolveDir: path.dirname(file) });
    }
    return id;
  }

  async function gateLiveSdkFile(
    context: SwapResolveContext,
    supplied: SuppliedRows,
    source: string,
    importer: string | undefined,
    resolveOptions: { ssr?: boolean } | undefined,
    routed: string | { id: string; external?: boolean } | null,
  ): Promise<string | { id: string; external?: boolean } | null> {
    if (typeof routed === 'string') return routed;
    const target = routed ?? await context.resolve(source, importer, { ...resolveOptions, skipSelf: true });
    if (target === null) return null;
    const url = realFileUrlOf(target.id);
    if (url === null) return target;
    const isLoadedFile = importer === undefined && supplied.liveSdkUrls.has(url);
    if (isLoadedFile) return target;
    const specifier = unaliasedSpecifier(source) ?? source;
    const importerUrl = toImporterUrl(importer);
    const isPassThroughLoad =
      isPassThroughEntry(supplied, specifier, url) ||
      isPassThroughPackageFile(supplied, importerUrl, url);
    if (isPassThroughLoad) {
      supplied.liveSdkUrls.add(url);
      return target;
    }
    const isRowImport = rowSpecifierOf(importer) === specifier;
    const load = { specifier, importer: importerUrl, url };
    const stopped = suppliedRowsStopFor(load, supplied.liveSdkUrls, { isRowImport, isEsmImport: true });
    if (stopped === null) return target;
    return refusedFileIdFor(specifier, fileURLToPath(url), supplied.refusal(specifier, 'page'));
  }

  async function gateSandboxSdkFile(
    context: SwapResolveContext,
    source: string,
    importer: string | undefined,
    resolveOptions: { ssr?: boolean } | undefined,
    routed: string | { id: string; external?: boolean } | null,
  ): Promise<string | { id: string; external?: boolean } | null> {
    if (typeof routed === 'string') return routed;
    const rawUnaliased = unaliasedSpecifier(source) ?? source;
    const bare = splitBareSpecifier(rawUnaliased);
    if (bare.startsWith('\0') || (isOurCode(importer) && !isBypassedBridgeImport(bare, importer))) {
      return routed;
    }
    const target = routed ?? await context.resolve(bare, importer, { ...resolveOptions, skipSelf: true });
    if (target === null) return routed;
    const url = realFileUrlOf(target.id);
    if (url === null) return routed;
    if (importer === undefined && allowedUrls.has(url)) return routed;
    const importerUrl = toImporterUrl(importer);
    const stopped = stopFor({ specifier: bare, importer: importerUrl, url, aiMode: aiMode() }, allowedUrls);
    if (stopped === null) return routed;
    return stoppedSandboxFileIdFor(bare, fileURLToPath(url), stopped);
  }

  return { gateLiveSdkFile, gateSandboxSdkFile };
}
