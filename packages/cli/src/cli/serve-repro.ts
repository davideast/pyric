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
import { discoverServe, probeHostUrl, selectProjectHost, type Discovered } from '../serve/discovery.js';
import { HOSTED_REPRO_PATH } from '../serve/hosted/method-protocol.js';
import {
  discoverHttpsPointer,
  fetchLoopbackTarget,
  probeHttpsHostUrl,
  resolveLoopbackTlsTrustForTarget,
  resolveSessionTokenForTarget,
} from '../serve/local-session-token.js';

interface Output { write(value: string): void }

export interface ServeReproDeps {
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
  discover?: (cwd: string) => Promise<Discovered | null>;
}

const DEFAULT_OUT = 'pyric-repro.json';

async function resolveExplicitUrlHost(
  command: string,
  explicitUrl: string,
  cwd: string,
  err: Output,
): Promise<{ base: string; instanceId: string } | { exit: number }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(explicitUrl);
    const isHttp = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    const hasCredentials = parsedUrl.username.length > 0 || parsedUrl.password.length > 0;
    if (!isHttp || hasCredentials) throw new Error('Invalid URL');
  } catch {
    err.write(`pyric ${command}: --url must be an HTTP(S) URL without credentials.\n`);
    return { exit: 2 };
  }
  const hit =
    (parsedUrl.protocol === 'https:' ? await probeHttpsHostUrl(parsedUrl.origin, cwd) : null) ??
    (await probeHostUrl(parsedUrl.origin));
  if (hit === null || hit.instanceId === null) {
    err.write(`pyric ${command}: no running Node host found at ${explicitUrl}. Start \`pyric sandbox\` or the Vite dev server, reproduce the problem, then run this command.\n`);
    return { exit: 2 };
  }
  return { base: hit.base, instanceId: hit.instanceId };
}

async function resolveHostedProjectKey(
  base: string,
  token: string | undefined,
  fallbackProjectDir: string,
): Promise<string> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const initRes = await fetchLoopbackTarget(
      new URL('/__pyric/init.json', base).toString(),
      {
        headers,
        signal: AbortSignal.timeout(3_000),
      },
      fallbackProjectDir,
    );
    if (initRes.ok) {
      const payload = (await initRes.json()) as {
        projectKey?: unknown;
        workerInit?: { projectKey?: unknown };
      };
      const key = payload.workerInit?.projectKey ?? payload.projectKey;
      if (typeof key === 'string' && key.length > 0) return key;
    }
  } catch {
    // Fall back to caller's directory if init.json is unavailable.
  }
  return realpathSync(fallbackProjectDir);
}

/**
 * Ask the running Node host for its repro file. Returns the body, or the exit
 * code after writing why to `err`. `command` prefixes each message.
 */
export async function fetchReproBody(
  command: string,
  cwd: string,
  err: Output,
  discover: ServeReproDeps['discover'],
  options: { url?: string; explicitProjectDir?: string } = {},
): Promise<string | { exit: number }> {
  const projectDir = options.explicitProjectDir
    ? resolve(cwd, options.explicitProjectDir)
    : cwd;
  let base: string;
  let instanceId: string;
  let explicitToken: string | undefined;

  if (typeof options.url === 'string') {
    if (options.url.length === 0) {
      err.write(`pyric ${command}: --url requires a URL.\n`);
      return { exit: 2 };
    }
    const resolvedHost = await resolveExplicitUrlHost(command, options.url, projectDir, err);
    if ('exit' in resolvedHost) return resolvedHost;
    base = resolvedHost.base;
    instanceId = resolvedHost.instanceId;
  } else {
    let host: Discovered | null;
    if (discover) {
      host = await discover(projectDir);
    } else {
      host =
        (await discoverHttpsPointer(projectDir)) ??
        selectProjectHost(await discoverServe(projectDir, () => {}), () => {});
    }
    if (host === null || host.instanceId === null) {
      err.write(`pyric ${command}: no running Node host found for this project. Start \`pyric sandbox\` or the Vite dev server, reproduce the problem, then run this command.\n`);
      return { exit: 2 };
    }
    base = host.base;
    instanceId = host.instanceId;
    explicitToken = host.token;
  }

  let response: Response;
  try {
    const token = resolveSessionTokenForTarget({
      explicitToken,
      url: base,
      cwd: projectDir,
    });
    let targetProjectDir: string;
    if (typeof options.url === 'string' && options.explicitProjectDir === undefined) {
      targetProjectDir = await resolveHostedProjectKey(base, token, projectDir);
    } else {
      targetProjectDir = realpathSync(projectDir);
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const tlsCwd =
      resolveLoopbackTlsTrustForTarget({ cwd: projectDir, url: base }) !== undefined
        ? projectDir
        : targetProjectDir;
    response = await fetchLoopbackTarget(
      new URL(HOSTED_REPRO_PATH, base).toString(),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ instanceId, projectDir: targetProjectDir }),
        signal: AbortSignal.timeout(60_000),
      },
      tlsCwd,
    );
  } catch (error) {
    err.write(`pyric ${command}: the host at ${base} did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
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
  const urlFlag = parsed.flags.get('url');
  if (urlFlag === true) {
    err.write('pyric serve repro capture: --url requires a URL.\n');
    return 2;
  }
  const projectDirFlag = parsed.flags.get('project-dir');
  if (projectDirFlag === true) {
    err.write('pyric serve repro capture: --project-dir requires a path.\n');
    return 2;
  }
  const fetched = await fetchReproBody('serve repro capture', cwd, err, deps.discover, {
    ...(typeof urlFlag === 'string' ? { url: urlFlag } : {}),
    ...(typeof projectDirFlag === 'string' ? { explicitProjectDir: projectDirFlag } : {}),
  });
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
