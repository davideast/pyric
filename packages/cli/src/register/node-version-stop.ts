/**
 * Non-Node runtime (`Bun`, `Deno`) and Node `< 22.15` hard stops (ADR 0023, #1624).
 *
 * `@pyric/cli` requires Node `>= 22.15` so synchronous `module.registerHooks`
 * intercepts both ESM `import` and CommonJS `require()` before any real
 * Firebase SDK file executes. Non-Node runtimes (`bun --preload`, `deno`) do
 * not run Node `module.registerHooks` (even when `process.versions.node`
 * reports a Node compatibility string), so activation stops immediately with
 * `PYRIC_UNSUPPORTED_RUNTIME` naming the runtime.
 */

export const UNSUPPORTED_NODE_VERSION_CODE = 'PYRIC_UNSUPPORTED_NODE_VERSION';
export const UNSUPPORTED_RUNTIME_CODE = 'PYRIC_UNSUPPORTED_RUNTIME';

export interface RuntimeVersions {
  readonly node?: string;
  readonly bun?: string;
  readonly deno?: string;
}

export interface NonNodeRuntime {
  readonly name: 'Bun' | 'Deno';
  readonly version: string;
}

export function detectNonNodeRuntime(
  versions: RuntimeVersions = process.versions,
  denoGlobal: unknown = (globalThis as { Deno?: unknown }).Deno,
): NonNodeRuntime | null {
  if (typeof versions.bun === 'string' && versions.bun.length > 0) {
    return { name: 'Bun', version: versions.bun };
  }
  if (typeof versions.deno === 'string' && versions.deno.length > 0) {
    return { name: 'Deno', version: versions.deno };
  }
  if (typeof denoGlobal === 'object' && denoGlobal !== null) {
    const versionObj = (denoGlobal as { version?: { deno?: unknown } }).version;
    let denoVersion = 'unknown';
    if (typeof versionObj?.deno === 'string' && versionObj.deno.length > 0) {
      denoVersion = versionObj.deno;
    }
    return { name: 'Deno', version: denoVersion };
  }
  return null;
}

export function createUnsupportedRuntimeError(
  surface: string = '@pyric/cli/register',
  runtime: NonNodeRuntime,
): Error & { code: string } {
  let label: string = runtime.name;
  if (runtime.version !== 'unknown') {
    label = `${runtime.name} ${runtime.version}`;
  }
  const message =
    `${surface}: ${label} is not a supported Node runtime [${UNSUPPORTED_RUNTIME_CODE}].\n` +
    `  ${runtime.name} does not run Node module.registerHooks, so firebase and firebase-admin imports cannot be swapped or stopped and would reach live Firebase.\n` +
    '  Run this process with `node` (Node >= 22.15) or `npx tsx` instead.\n' +
    `  code: ${UNSUPPORTED_RUNTIME_CODE}`;
  const error = new Error(message) as Error & { code: string };
  error.code = UNSUPPORTED_RUNTIME_CODE;
  return error;
}

export function requireNodeRuntime(
  surface: string = '@pyric/cli/register',
  versions: RuntimeVersions = process.versions,
  denoGlobal: unknown = (globalThis as { Deno?: unknown }).Deno,
  write?: (line: string) => void,
): void {
  const nonNode = detectNonNodeRuntime(versions, denoGlobal);
  if (nonNode === null) {
    return;
  }
  const error = createUnsupportedRuntimeError(surface, nonNode);
  write?.(`${error.message}\n`);
  throw error;
}

export function createUnsupportedNodeVersionError(
  surface: string = '@pyric/cli/register',
  nodeVersion: string = process.versions.node,
): Error & { code: string } {
  const message =
    `${surface}: Node ${nodeVersion} lacks module.registerHooks (requires Node >= 22.15).\n` +
    "  Without synchronous module.registerHooks, CommonJS require('firebase-admin') cannot be swapped or stopped and would reach live Firebase.\n" +
    '  Upgrade Node to >= 22.15.\n' +
    `  code: ${UNSUPPORTED_NODE_VERSION_CODE}`;
  const error = new Error(message) as Error & { code: string };
  error.code = UNSUPPORTED_NODE_VERSION_CODE;
  return error;
}

export function requireRegisterHooks<T extends (...args: never[]) => unknown>(
  registerHooks: T | undefined,
  surface: string = '@pyric/cli/register',
  nodeVersion: string = process.versions.node,
  write?: (line: string) => void,
): T {
  if (typeof registerHooks === 'function') {
    return registerHooks;
  }
  const error = createUnsupportedNodeVersionError(surface, nodeVersion);
  write?.(`${error.message}\n`);
  throw error;
}
