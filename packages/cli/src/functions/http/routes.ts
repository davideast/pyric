/**
 * Which request is for which onRequest function. The emulator path
 * `/{projectId}/{region}/{name}[/...]` is the one route this module owns
 * (firebase-tools `functionsEmulator.js:151-153`); the function sees `/` plus
 * whatever followed its name (`:1264`).
 */
import type { HttpFunctionInfo } from './discovery.js';

export interface AmbiguousRunService {
  service: string;
  exports: string[];
}

export type FunctionRoute =
  /** A served function, and the URL it sees. */
  | {
      kind: 'function';
      fn: HttpFunctionInfo;
      forwardUrl: string;
      ambiguousRunService?: AmbiguousRunService;
    }
  /** The emulator path shape under this project, before the function list is known. */
  | { kind: 'emulator-path' }
  /**
   * The emulator path shape with a name and region no served function has.
   * `key` is firebase-tools' trigger key, `{region}-{name}`.
   */
  | { kind: 'unknown-function'; key: string };

const RUN_SERVICE_QUERY = '?__pyric_run_service=1';

function toRunServiceSlug(exportName: string): string {
  return exportName.toLowerCase().replaceAll('_', '-');
}

/** A Cloud Functions region id: `us-central1`, `europe-west1`, `northamerica-northeast1`. */
const REGION = /^[a-z]+-[a-z]+\d+$/;

export interface FunctionRouteTable {
  projectId: string;
  /** Null until the child reports its functions. */
  functions: readonly HttpFunctionInfo[] | null;
}

/** Splits `/{a}/{b}/{c}/rest?query` without decoding, so the forwarded URL keeps the client's bytes. */
function splitPath(rawUrl: string): { segments: string[]; rest: string; search: string } {
  const queryAt = rawUrl.indexOf('?');
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  const parts = path.split('/');
  // parts[0] is the empty string before the leading slash.
  const segments = parts.slice(1, 4);
  const rest = parts.length > 4 ? `/${parts.slice(4).join('/')}` : '';
  return { segments, rest, search };
}

export function matchEmulatorPath(rawUrl: string, table: FunctionRouteTable): FunctionRoute | null {
  const { segments, rest, search } = splitPath(rawUrl);
  const [project, region, name] = segments;
  const isEmulatorShape = project === table.projectId && region !== undefined && REGION.test(region) && Boolean(name);
  if (!isEmulatorShape) return null;
  if (table.functions === null) return { kind: 'emulator-path' };
  let restPath = rest;
  if (restPath === '') {
    restPath = '/';
  }
  if (search === RUN_SERVICE_QUERY) {
    const callableMatches = table.functions.filter(
      (candidate) =>
        candidate.kind === 'callable' &&
        candidate.regions.includes(region) &&
        toRunServiceSlug(candidate.exportName) === name,
    );
    const chosen = callableMatches[0];
    if (chosen) {
      if (callableMatches.length > 1) {
        return {
          kind: 'function',
          fn: chosen,
          forwardUrl: restPath,
          ambiguousRunService: {
            service: name,
            exports: callableMatches.map((entry) => entry.exportName),
          },
        };
      }
      return { kind: 'function', fn: chosen, forwardUrl: restPath };
    }
  }
  const fn = table.functions.find((candidate) => candidate.exportName === name && candidate.regions.includes(region));
  // The gateway decides what an unknown key gets: a static directory may share the project id's name.
  if (!fn) return { kind: 'unknown-function', key: `${region}-${name}` };
  return { kind: 'function', fn, forwardUrl: `${restPath}${search}` };
}
