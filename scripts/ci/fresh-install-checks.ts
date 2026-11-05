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

// ─── Allowances ────────────────────────────────────────────────────────

/**
 * A refused request or firewall reject that does not fail the run, because
 * its source is known and named. It still shows in findings.txt as
 * `allowed (<label>)` on every run, and an allowance that matched nothing
 * in a run that reached its step fails the run as stale. The proxy and the
 * firewall still refuse what an allowance covers.
 */
export interface Allowance {
  name: string;
  /** What findings.txt shows in `allowed (<label>)`: the issue, or the allowance's name. */
  label: string;
  reason: string;
  template: string;
  /** `npm install`: during that step. `dev command running`: during a step while `npm run dev` runs. */
  step: 'npm install' | 'dev command running';
  /** A refused egress request to one of these hosts. */
  egressHosts?: readonly string[];
  /** A firewall reject to an address this name resolves to at run time. */
  resolvesTo?: string;
  port: number;
}

export const ALLOWANCES: readonly Allowance[] = [
  {
    name: 'chat-zstd-native-binary',
    label: '#2049',
    reason: "the chat template's @inbrowser/workspace pulls in @mongodb-js/zstd, whose install script downloads a prebuilt binary from GitHub and falls back to Node headers from nodejs.org (#2049)",
    template: 'chat',
    step: 'npm install',
    egressHosts: ['github.com', 'nodejs.org'],
    port: 443,
  },
  {
    name: 'next-dev-version-check',
    label: 'next-dev-version-check',
    reason: 'the Next.js dev server\'s version check, made by Next, not by pyric, and sent only to the npm registry',
    template: 'nextjs',
    step: 'dev command running',
    resolvesTo: REGISTRY_HOST,
    port: 443,
  },
];

/** What a check found: lines that fail the run, and lines an allowance covers. */
export interface Verdict {
  failing: string[];
  allowed: string[];
}

/** The addresses each allowance's `resolvesTo` name resolved to in this run. */
export type ResolvedNames = ReadonlyMap<string, readonly string[]>;

/** One form for an address, so `2606:4700:0000::22` and `2606:4700::22` compare equal. */
export function canonicalAddress(address: string): string {
  if (!address.includes(':')) return address;
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return address.toLowerCase();
  }
}

function stepHolding(time: string | undefined, steps: readonly StepRecord[]): StepRecord | undefined {
  const at = time === undefined ? Number.NaN : Date.parse(time);
  if (Number.isNaN(at)) return undefined;
  return steps.find((record) => Date.parse(record.start) <= at && at <= Date.parse(record.end));
}

function inAllowedStep(allowance: Allowance, record: StepRecord): boolean {
  if (record.template !== allowance.template) return false;
  if (allowance.step === 'npm install') return record.step === 'npm install';
  return [...record.started, ...record.running].some((command) => command.startsWith('npm run dev'));
}

interface Target {
  kind: 'egress' | 'firewall';
  host: string;
  port?: number;
  time?: string;
}

function allows(allowance: Allowance, target: Target, steps: readonly StepRecord[], resolved: ResolvedNames): boolean {
  const record = stepHolding(target.time, steps);
  if (record === undefined || !inAllowedStep(allowance, record) || target.port !== allowance.port) return false;
  if (target.kind === 'egress') return allowance.egressHosts?.includes(target.host.toLowerCase()) === true;
  if (allowance.resolvesTo === undefined) return false;
  const addresses = (resolved.get(allowance.resolvesTo) ?? []).map(canonicalAddress);
  return addresses.includes(canonicalAddress(target.host));
}

function coversKind(allowance: Allowance, kind: Target['kind']): boolean {
  if (kind === 'egress') return allowance.egressHosts !== undefined;
  return allowance.resolvesTo !== undefined;
}

/**
 * Sorts `findings` (one per target, same order) into allowed and failing,
 * and adds a failing line for each allowance of this kind that matched
 * nothing although its template reached the step it covers.
 */
function applyAllowances(
  kind: Target['kind'],
  items: readonly { target: Target; finding: string }[],
  steps: readonly StepRecord[],
  resolved: ResolvedNames,
  allowances: readonly Allowance[],
): Verdict {
  const verdict: Verdict = { failing: [], allowed: [] };
  const used = new Set<Allowance>();
  for (const { target, finding } of items) {
    const allowance = allowances.find((candidate) => coversKind(candidate, kind) && allows(candidate, target, steps, resolved));
    if (allowance === undefined) {
      verdict.failing.push(finding);
      continue;
    }
    used.add(allowance);
    verdict.allowed.push(`allowed (${allowance.label}): ${finding}; ${allowance.reason}`);
  }
  for (const allowance of allowances) {
    const reachedItsStep = steps.some((record) => inAllowedStep(allowance, record));
    if (coversKind(allowance, kind) && !used.has(allowance) && reachedItsStep) {
      verdict.failing.push(`stale allowance ${allowance.name} (${allowance.label}): matched nothing this run; remove it or fix it`);
    }
  }
  return verdict;
}

function egressVerdict(egress: readonly EgressEntry[], steps: readonly StepRecord[], allowances: readonly Allowance[]): Verdict {
  if (egress.length === 0) {
    return { failing: ['egress: no request went through the egress guard, so the install bypassed it or never ran'], allowed: [] };
  }
  const items = egress
    .filter((entry) => !entry.allowed)
    .map((entry) => ({
      target: { kind: 'egress' as const, host: entry.host, port: entry.port, time: entry.time },
      finding: `egress: refused ${entry.method} ${entry.host}:${entry.port} (only ${REGISTRY_HOST}:${REGISTRY_PORT} may be reached) ${stepAt(entry.time, steps)}`,
    }));
  return applyAllowances('egress', items, steps, new Map(), allowances);
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

/** One line per connection the firewall rejected, naming the step it fell in, sorted by the allowances. */
export function firewallFindings(
  rejects: readonly FirewallReject[],
  steps: readonly StepRecord[],
  resolved: ResolvedNames = new Map(),
  allowances: readonly Allowance[] = ALLOWANCES,
): Verdict {
  const items = rejects.map((reject) => {
    const where = reject.port === undefined ? reject.destination : `${reject.destination}:${reject.port}`;
    return {
      target: { kind: 'firewall' as const, host: reject.destination, port: reject.port, time: reject.time },
      finding: `firewall: rejected a direct ${reject.protocol} connection to ${where} ${stepAt(reject.time, steps)}`,
    };
  });
  return applyAllowances('firewall', items, steps, resolved, allowances);
}

/**
 * Every problem in one run: a failed create, install, start or flow step; an
 * uncaught page error; an unhandled rejection; a worker error or crashed
 * page; a 5xx response or a pyric host error to a page; a page request the
 * browser guard blocked; a runtime chip that is not Ready; an error stack or
 * a Next `⨯` error in the dev server's output; and any request the egress
 * guard refused, or no guarded traffic at all. Refused requests an
 * allowance covers are listed in `allowed` instead.
 */
export function crashFindings(run: RunEvidence, allowances: readonly Allowance[] = ALLOWANCES): Verdict {
  const findings: string[] = [];
  for (const evidence of run.templates) {
    const own: string[] = [];
    if (evidence.failedStep) own.push(`${evidence.failedStep.step} failed: ${firstLine(evidence.failedStep.reason)}`);
    own.push(...browserFindings(evidence), ...hostErrorFindings(evidence.hostErrors), ...chipFindings(evidence.chipStates), ...serverErrorFindings(evidence.serverOutput));
    findings.push(...own.map((finding) => `${evidence.template}: ${finding}`));
  }
  const egress = egressVerdict(run.egress, run.steps ?? [], allowances);
  return { failing: [...findings, ...egress.failing], allowed: egress.allowed };
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
