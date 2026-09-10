/**
 * `pyric <tool> <method> --<arg> <value>`: one method record, run from the
 * command line against the project's own in-process sandbox.
 *
 * The record is the declaration the MCP tool and this command both derive from,
 * so the CLI cannot drift from the surface: it reads the same schema, runs the
 * same validator, calls the same handler, and persists to the same state file
 * `pyric mcp --in-process` reads. The only difference is the transport, and the
 * two things the transport changes are that an object argument arrives as a
 * JSON string, and that any argument may instead be read from a file with
 * `--<arg>-file <path>`.
 */
import { initializeSandbox } from 'pyric/sandbox';
import {
  IN_PROCESS_STATE_RELATIVE,
  loadProjectRules,
  loadSandboxSnapshot,
  openPersistedServices,
  saveSandboxSnapshot,
} from '../bridge/server/in-process.js';
import { loadStorageSidecar, saveStorageSidecar } from '../bridge/server/storage-sidecar.js';
import { createSurfaceContext } from '../bridge/surface/context.js';
import { validateArguments } from '../bridge/surface/method-validation.js';
import { methodByKey } from '../bridge/surface/methods/registry.js';
import { markDenial, thrownFailure } from '../bridge/surface/rules-verdict.js';
import type { OperationResult } from '../bridge/surface/types.js';
import { discoverServe } from '../serve/discovery.js';
import { argumentsFromFlags } from './surface-method-args.js';
import { selectAllowProduction } from './mcp-proxy.js';
import type { ParsedArgs } from './parse-args.js';

/** Where output goes. A test supplies its own so it can read what was printed. */
export interface SurfaceMethodDeps {
  cwd?: string;
  stdout?: { write(text: string): void };
  stderr?: { write(text: string): void };
  /** Environment `--allow-production`'s fallback is read from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /** How a running serve is looked for. A test supplies one that finds nothing. */
  discover?: typeof discoverServe;
}

/** Exit code for a call the surface refused, distinct from a usage error. */
const CALL_FAILED = 2;
const USAGE_ERROR = 1;

/**
 * The sentence printed when a running serve owns this project's sandbox.
 *
 * A running serve holds the sandbox in the browser tab, and this command can
 * only act on the in-process sandbox in `.pyric/state`. Acting there silently
 * would answer about a different sandbox than the one the app is using, so the
 * command refuses unless the caller says which one they mean.
 */
export function runningServeRefusal(url: string): string {
  return (
    `a running \`pyric serve\` at ${url} owns this project's sandbox in the browser, ` +
    `and this command acts only on the in-process sandbox in ${IN_PROCESS_STATE_RELATIVE}. ` +
    'Pass --in-process to act on that one anyway, or reach the running sandbox through `pyric mcp`.'
  );
}

/** Print one result the way every service command prints one. */
function report(
  result: OperationResult,
  stdout: { write(text: string): void },
  json: boolean,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  stdout.write(`${result.summary}\n`);
  if (result.data !== undefined) stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
}

/**
 * Run one method record against the project's sandbox. The sandbox is loaded
 * from `.pyric/state` before the call and written back after it, so a sequence
 * of commands composes the same way a sequence of MCP calls does.
 */
export async function runSurfaceMethod(
  key: string,
  parsed: ParsedArgs,
  deps: SurfaceMethodDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const method = methodByKey(key);
  const allowProduction = selectAllowProduction(parsed, env);

  const read = argumentsFromFlags(method, parsed, cwd);
  if ('error' in read) {
    stderr.write(`pyric: ${read.error}\n`);
    return USAGE_ERROR;
  }

  // Which sandbox this command acts on is the first thing it says. Without
  // `--in-process`, a running serve for this project means the caller most
  // likely meant the sandbox the app is using, which this command cannot reach.
  // Only the project's own pointer counts: a port scan can find a serve that
  // belongs to another project on the same machine.
  if (parsed.flags.get('in-process') !== true) {
    const found = await (deps.discover ?? discoverServe)(cwd);
    if (found !== null && found.source.startsWith('pointer')) {
      stderr.write(`pyric: ${runningServeRefusal(found.url)}\n`);
      return USAGE_ERROR;
    }
  }
  stderr.write(`pyric: in-process sandbox, ${IN_PROCESS_STATE_RELATIVE}\n`);

  const sandbox = initializeSandbox();
  const storage = openPersistedServices(sandbox, cwd);
  loadSandboxSnapshot(sandbox, cwd);
  loadProjectRules(sandbox, cwd);
  await loadStorageSidecar(storage, cwd);

  const ctx = createSurfaceContext(sandbox, cwd);
  const rejection = validateArguments(method, read.args, allowProduction);
  if (rejection !== null) {
    stderr.write(`pyric: ${rejection.summary}\n`);
    return CALL_FAILED;
  }

  let result: OperationResult;
  try {
    result = markDenial(method.tool, await method.handler(read.args, ctx));
  } catch (error) {
    const failed = markDenial(method.tool, thrownFailure(error));
    stderr.write(`pyric: ${failed.summary}\n`);
    return CALL_FAILED;
  }

  // A read changes nothing, so it writes nothing back: running `whoami` in a
  // directory must not create a state file there.
  if (result.ok && method.effect !== 'read') {
    saveSandboxSnapshot(sandbox, cwd);
    await saveStorageSidecar(storage, cwd);
  }
  report(result, stdout, parsed.flags.get('json') === true);
  if (!result.ok) {
    stderr.write(`pyric: state in ${IN_PROCESS_STATE_RELATIVE} is unchanged.\n`);
    return CALL_FAILED;
  }
  return 0;
}
