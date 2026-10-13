/**
 * `pyric serve repro capture` and `pyric serve repro replay`.
 *
 *   pyric serve repro capture [--out FILE] [--force] [--url URL]
 *   pyric serve repro replay <FILE> [--plane node|worker] [--json]
 *
 * `capture` asks the running Node host (`pyric sandbox` or the Vite plugin)
 * for its repro file and writes it. `replay` runs a repro file on a fresh
 * Node host and a fresh worker host and reports the first divergence from the
 * recording on each, and every frame where the two hosts disagree. Exit 1 on
 * any divergence.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedArgs } from './parse-args.js';
import { discoverServe, type Discovered } from '../serve/discovery.js';
import { HOSTED_REPRO_PATH } from '../serve/hosted/method-protocol.js';

interface Output { write(value: string): void }

export interface ServeReproDeps {
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
  discover?: (cwd: string) => Promise<Discovered | null>;
}

const DEFAULT_OUT = 'pyric-repro.json';

/**
 * Ask the running Node host for its repro file. Returns the body, or the exit
 * code after writing why to `err`. `command` prefixes each message.
 */
export async function fetchReproBody(
  command: string,
  cwd: string,
  err: Output,
  discover: ServeReproDeps['discover'],
): Promise<string | { exit: number }> {
  const host = await (discover ?? discoverServe)(cwd);
  const hasNoHost = host === null || host.instanceId === null;
  if (hasNoHost) {
    err.write(`pyric ${command}: no running Node host found for this project. Start \`pyric sandbox\` or the Vite dev server, reproduce the problem, then run this command.\n`);
    return { exit: 2 };
  }
  let response: Response;
  try {
    response = await fetch(new URL(HOSTED_REPRO_PATH, host.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: host.instanceId, projectDir: realpathSync(cwd) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    err.write(`pyric ${command}: the host at ${host.base} did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exit: 2 };
  }
  const isUnsupported = response.status === 404;
  if (isUnsupported) {
    err.write(`pyric ${command}: the running server is not a Node host. It reads the Node host that \`pyric sandbox\` and the Vite plugin start.\n`);
    return { exit: 2 };
  }
  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // The body is not JSON; print it as it came.
    }
    err.write(`pyric ${command}: ${message}\n`);
    return { exit: 1 };
  }
  return body;
}

export async function runServeReproCapture(parsed: ParsedArgs, deps: ServeReproDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const outFlag = parsed.flags.get('out');
  const target = resolve(cwd, typeof outFlag === 'string' ? outFlag : DEFAULT_OUT);
  const force = Boolean(parsed.flags.get('force'));
  const refusesOverwrite = existsSync(target) && !force;
  if (refusesOverwrite) {
    err.write(`pyric serve repro capture: ${target} already exists. Pass --force to overwrite it.\n`);
    return 2;
  }
  const fetched = await fetchReproBody('serve repro capture', cwd, err, deps.discover);
  if (typeof fetched !== 'string') return fetched.exit;
  const body = fetched;
  writeFileSync(target, body);
  const repro = JSON.parse(body) as { entries: unknown[]; truncated: boolean };
  out.write(`Wrote ${repro.entries.length} log entries and the starting state to ${target}.\n`);
  if (repro.truncated) out.write('The log is bounded; older entries were dropped.\n');
  out.write(`Replay it with: pyric serve repro replay ${target}\n`);
  return 0;
}

export async function runServeReproReplay(parsed: ParsedArgs, deps: ServeReproDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const file = parsed.positional[0];
  if (typeof file !== 'string') {
    err.write('pyric serve repro replay: name the repro file to replay.\n');
    return 2;
  }
  const planeFlag = parsed.flags.get('plane');
  const planes = planeFlag === 'node' || planeFlag === 'worker' ? [planeFlag] as const : undefined;
  const hasInvalidPlane = planeFlag !== undefined && planes === undefined;
  if (hasInvalidPlane) {
    err.write("pyric serve repro replay: --plane is 'node' or 'worker'.\n");
    return 2;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(cwd, file), 'utf8'));
  } catch (error) {
    err.write(`pyric serve repro replay: could not read ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { replayRepro } = await import('../serve/repro/replay.js');
  let report: Awaited<ReturnType<typeof replayRepro>>;
  try {
    report = await replayRepro(value, planes ? { planes: [...planes] } : {});
  } catch (error) {
    err.write(`pyric serve repro replay: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const json = Boolean(parsed.flags.get('json'));
  if (json) {
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  for (const plane of Object.values(report.planes)) {
    const first = plane.firstDivergence;
    if (first === null) {
      out.write(`${plane.plane}: matches the recording (${plane.checked} results and events).\n`);
      continue;
    }
    const where = [first.operation.method, first.operation.instance, first.operation.path].filter(Boolean).join(' ');
    out.write(`${plane.plane}: first divergence at entry ${first.entry} (${first.kind} of ${where || 'an operation'}, session ${first.session}): ${first.reason}.\n`);
    out.write(`  expected ${JSON.stringify(first.expected)}\n`);
    out.write(`  actual   ${JSON.stringify(first.actual)}\n`);
  }
  if (report.planeDifferences.length > 0) {
    const first = report.planeDifferences[0];
    out.write(`The Node host and the worker host differ at ${report.planeDifferences.length} frame(s), first at entry ${first.entry}.\n`);
  }
  for (const warning of report.warnings) out.write(`warning: ${warning}\n`);
  return report.ok ? 0 : 1;
}
