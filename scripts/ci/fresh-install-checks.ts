/**
 * What fails the nightly fresh-install run (`scripts/ci/fresh-install.ts`),
 * and the egress guard its installs go through. Every check is in
 * `crashFindings`, which reads what the run recorded and returns one line per
 * problem; an empty list is a pass. The checks can move to the shared
 * crash-watch module under test/apps/ once that lands.
 */
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

/** The only host an install may reach, and only over TLS. */
export const REGISTRY_HOST = 'registry.npmjs.org';
export const REGISTRY_PORT = 443;

/** Prefixes the page init script writes with `console.error`, so the browser log carries them. */
export const UNHANDLED_REJECTION_MARK = '[fresh-install unhandled rejection]';
export const WORKER_ERROR_MARK = '[fresh-install worker error]';

/** One request the egress guard saw: a CONNECT tunnel or a plain proxied request. */
export interface EgressEntry {
  method: string;
  host: string;
  port: number;
  allowed: boolean;
  /** When the guard saw it, as an ISO time. */
  time?: string;
}

/** One driver step, with the commands it started and the ones running while it ran (steps.jsonl). */
export interface StepRecord {
  template: string;
  index: number;
  step: string;
  started: readonly string[];
  running: readonly string[];
  start: string;
  end: string;
}

/** One connection the firewall rejected, from the kernel log. */
export interface FirewallReject {
  time: string;
  protocol: string;
  destination: string;
  port?: number;
}

/** What one template's run recorded. */
export interface TemplateEvidence {
  template: string;
  /** The step that threw (create, install, start, or the flow), with its reason. */
  failedStep?: { step: string; reason: string };
  /** The driver's browser log: console lines, page errors, error responses, and crash lines. */
  browserLog: readonly string[];
  /** The dev command's stdout and stderr. */
  serverOutput: string;
  /** The runtime chip after each load: `Ready`, `absent`, or what it showed instead. */
  chipStates: readonly string[];
  /** Error responses from `/__pyric/` routes to the pages (the driver's `unexpectedHostErrors()`). */
  hostErrors?: readonly string[];
}

export interface RunEvidence {
  templates: readonly TemplateEvidence[];
  /** Every request the egress guard saw during the run. */
  egress: readonly EgressEntry[];
  /** Every step the driver ran, to say which one each refused request fell in. */
  steps?: readonly StepRecord[];
}

export function isRegistryRequest(host: string, port: number): boolean {
  return host.toLowerCase() === REGISTRY_HOST && port === REGISTRY_PORT;
}

/**
 * A V8 stack frame line: `    at fn (<location>:1:2)` or `    at <location>:1:2`
 * for any location (absolute, relative, `file:`, `node:`, `webpack-internal:`,
 * `<anonymous>`), or a frame with no position, `(<anonymous>)` or `(index 0)`.
 */
const STACK_FRAME = /^\s+at\s+\S.*(?::\d+:\d+\)?|\(<anonymous>\)|\(index \d+\))\s*$/;
/** Next prints every server error after this mark, with or without a stack. */
const NEXT_ERROR = /^\s*⨯\s/;
const PAGE_ERROR = /^\[page \d+ error\] /;
const SERVER_ERROR_RESPONSE = /^\[page \d+ response 5\d\d\] /;
const BLOCKED_EGRESS = /^\[blocked external (?:request|WebSocket)\] /;
const SHARED_WORKER_ERROR = 'Pyric SharedWorker error';
const PAGE_CRASHED = '[page crashed]';

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}

function browserFindings(evidence: TemplateEvidence): string[] {
  const findings: string[] = [];
  for (const line of evidence.browserLog) {
    const isWorkerCrash = line.includes(WORKER_ERROR_MARK) || line.includes(SHARED_WORKER_ERROR) || line.startsWith(PAGE_CRASHED);
    if (PAGE_ERROR.test(line)) findings.push(`uncaught page error: ${firstLine(line)}`);
    else if (SERVER_ERROR_RESPONSE.test(line)) findings.push(`server error response: ${line}`);
    else if (BLOCKED_EGRESS.test(line)) findings.push(`page tried to leave the machine: ${line}`);
    else if (line.includes(UNHANDLED_REJECTION_MARK)) findings.push(`unhandled rejection: ${firstLine(line)}`);
    else if (isWorkerCrash) findings.push(`worker crash: ${firstLine(line)}`);
  }
  return findings;
}

/**
 * One finding per error in the dev output: each Next `⨯` line, and the line
 * above each run of stack frames (the error the stack belongs to). A stack
 * under a `⨯` line is the same error, reported once.
 */
function serverErrorFindings(output: string): string[] {
  const lines = output.split('\n');
  const headers = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const startsStack = STACK_FRAME.test(line) && !STACK_FRAME.test(lines[index - 1] ?? '');
    const hasHeaderAbove = index > 0 && (lines[index - 1] ?? '').trim() !== '';
    if (NEXT_ERROR.test(line)) headers.add(index);
    else if (startsStack && hasHeaderAbove) headers.add(index - 1);
    else if (startsStack) headers.add(index);
  }
  return [...headers].sort((a, b) => a - b).map((index) => `error in dev server output: ${lines[index]!.trim()}`);
}

function hostErrorFindings(hostErrors: readonly string[] = []): string[] {
  return hostErrors.map((request) => `pyric host answered with an error: ${request}`);
}

function chipFindings(states: readonly string[]): string[] {
  return states
    .filter((state) => state !== 'Ready' && state !== 'absent')
    .map((state) => `runtime chip is not Ready: ${state}`);
}

function egressFindings(egress: readonly EgressEntry[], steps: readonly StepRecord[]): string[] {
  if (egress.length === 0) {
    return ['egress: no request went through the egress guard, so the install bypassed it or never ran'];
  }
  return egress
    .filter((entry) => !entry.allowed)
    .map((entry) => `egress: refused ${entry.method} ${entry.host}:${entry.port} (only ${REGISTRY_HOST}:${REGISTRY_PORT} may be reached) ${stepAt(entry.time, steps)}`);
}

function describeStep(record: StepRecord): string {
  const parts = [`${record.template} step ${record.index} "${record.step}"`];
  if (record.started.length > 0) parts.push(`started: ${record.started.join(' | ')}`);
  if (record.running.length > 0) parts.push(`running: ${record.running.join(' | ')}`);
  return parts.join('; ');
}

/**
 * Which step `time` fell in: the step whose window holds it, or the last
 * step that ended before it when it fell between steps.
 */
export function stepAt(time: string | undefined, steps: readonly StepRecord[]): string {
  const at = time === undefined ? Number.NaN : Date.parse(time);
  if (Number.isNaN(at)) return '(at an unrecorded time)';
  const holding = steps.find((record) => Date.parse(record.start) <= at && at <= Date.parse(record.end));
  if (holding) return `(at ${time}, during ${describeStep(holding)})`;
  const before = steps.filter((record) => Date.parse(record.end) < at).at(-1);
  if (before) return `(at ${time}, between steps, after ${describeStep(before)})`;
  return `(at ${time}, before the first step)`;
}

/** `dmesg --time-format iso` time: `2026-11-05T01:02:03,123456+00:00`, with the fraction cut to milliseconds. */
function isoFromDmesg(stamp: string): string {
  return stamp.replace(/,(\d{3})\d*/, '.$1');
}

/** The firewall's LOG lines (`dmesg --time-format iso`), one reject each. */
export function parseFirewallRejects(text: string): FirewallReject[] {
  const rejects: FirewallReject[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('fresh-install-reject: ')) continue;
    const stamp = line.split(/\s/, 1)[0] ?? '';
    const destination = line.match(/\bDST=(\S+)/)?.[1];
    if (destination === undefined) continue;
    const port = line.match(/\bDPT=(\d+)/)?.[1];
    rejects.push({
      time: isoFromDmesg(stamp),
      protocol: line.match(/\bPROTO=(\S+)/)?.[1] ?? 'unknown',
      destination,
      ...(port === undefined ? {} : { port: Number(port) }),
    });
  }
  return rejects;
}

/** One finding per connection the firewall rejected, naming the step it fell in. */
export function firewallFindings(rejects: readonly FirewallReject[], steps: readonly StepRecord[]): string[] {
  return rejects.map((reject) => {
    const target = reject.port === undefined ? reject.destination : `${reject.destination}:${reject.port}`;
    return `firewall: rejected a direct ${reject.protocol} connection to ${target} ${stepAt(reject.time, steps)}`;
  });
}

/**
 * Every problem in one run: a failed create, install, start or flow step; an
 * uncaught page error; an unhandled rejection; a worker error or crashed
 * page; a 5xx response or a pyric host error to a page; a page request the
 * browser guard blocked; a runtime chip that is not Ready; an error stack or
 * a Next `⨯` error in the dev server's output; and any request the egress
 * guard refused, or no guarded traffic at all.
 */
export function crashFindings(run: RunEvidence): string[] {
  const findings: string[] = [];
  for (const evidence of run.templates) {
    const own: string[] = [];
    if (evidence.failedStep) own.push(`${evidence.failedStep.step} failed: ${firstLine(evidence.failedStep.reason)}`);
    own.push(...browserFindings(evidence), ...hostErrorFindings(evidence.hostErrors), ...chipFindings(evidence.chipStates), ...serverErrorFindings(evidence.serverOutput));
    findings.push(...own.map((finding) => `${evidence.template}: ${finding}`));
  }
  findings.push(...egressFindings(run.egress, run.steps ?? []));
  return findings;
}

// ─── Egress guard ──────────────────────────────────────────────────────

function splitHostPort(authority: string): { host: string; port: number } {
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { host: authority, port: 443 };
  return { host: authority.slice(0, colon).replace(/^\[|\]$/g, ''), port: Number(authority.slice(colon + 1)) };
}

function tunnel(client: Socket, head: Buffer, host: string, port: number): void {
  let opened = false;
  const upstream = connect(port, host, () => {
    opened = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  // Before the tunnel opens the client still waits for a status line.
  upstream.on('error', () => {
    if (opened) client.destroy();
    else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  client.on('error', () => upstream.destroy());
}

/** A proxy on 127.0.0.1:`port` that tunnels only to the registry and passes every request to `record`. */
export function startEgressProxy(port: number, record: (entry: EgressEntry) => void): Promise<Server> {
  const server = createServer((request, response) => {
    // Plain HTTP never reaches the registry, which is TLS only.
    const raw = request.url ?? '';
    const target = URL.canParse(raw) ? new URL(raw) : undefined;
    record({ method: request.method ?? 'GET', host: target?.hostname ?? raw, port: Number(target?.port || 80), allowed: false, time: new Date().toISOString() });
    response.writeHead(403).end(`fresh-install egress guard: only https://${REGISTRY_HOST} may be reached\n`);
  });
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const { host, port: targetPort } = splitHostPort(request.url ?? '');
    const allowed = isRegistryRequest(host, targetPort);
    record({ method: 'CONNECT', host, port: targetPort, allowed, time: new Date().toISOString() });
    if (allowed) tunnel(client, head, host, targetPort);
    else client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}
