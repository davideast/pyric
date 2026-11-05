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
}

export interface RunEvidence {
  templates: readonly TemplateEvidence[];
  /** Every request the egress guard saw during the run. */
  egress: readonly EgressEntry[];
}

export function isRegistryRequest(host: string, port: number): boolean {
  return host.toLowerCase() === REGISTRY_HOST && port === REGISTRY_PORT;
}

/** `    at fn (file:///x.js:1:2)` or `    at node:internal/x:1:2`: a V8 stack frame line. */
const STACK_FRAME = /^\s+at\s+(?:.+\s\()?(?:file:|node:|\/|[A-Za-z]:\\)\S*:\d+:\d+\)?\s*$/;
const PAGE_ERROR = /^\[page \d+ error\] /;
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
    else if (line.includes(UNHANDLED_REJECTION_MARK)) findings.push(`unhandled rejection: ${firstLine(line)}`);
    else if (isWorkerCrash) findings.push(`worker crash: ${firstLine(line)}`);
  }
  return findings;
}

/** The line above each run of stack frames: the error the stack belongs to. */
function serverStackFindings(output: string): string[] {
  const lines = output.split('\n');
  const findings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const startsStack = STACK_FRAME.test(lines[index]!) && !STACK_FRAME.test(lines[index - 1] ?? '');
    if (!startsStack) continue;
    const header = (lines[index - 1] ?? '').trim() || lines[index]!.trim();
    findings.push(`error stack in dev server output: ${header}`);
  }
  return findings;
}

function chipFindings(states: readonly string[]): string[] {
  return states
    .filter((state) => state !== 'Ready' && state !== 'absent')
    .map((state) => `runtime chip is not Ready: ${state}`);
}

function egressFindings(egress: readonly EgressEntry[]): string[] {
  if (egress.length === 0) {
    return ['egress: no request went through the egress guard, so the install bypassed it or never ran'];
  }
  return egress
    .filter((entry) => !entry.allowed)
    .map((entry) => `egress: refused ${entry.method} ${entry.host}:${entry.port} (only ${REGISTRY_HOST}:${REGISTRY_PORT} may be reached)`);
}

/**
 * Every problem in one run: a failed create, install, start or flow step; an
 * uncaught page error; an unhandled rejection; a worker error or crashed
 * page; a runtime chip that is not Ready; an error stack in the dev server's
 * output; and any request the egress guard refused, or no guarded traffic at all.
 */
export function crashFindings(run: RunEvidence): string[] {
  const findings: string[] = [];
  for (const evidence of run.templates) {
    const own: string[] = [];
    if (evidence.failedStep) own.push(`${evidence.failedStep.step} failed: ${firstLine(evidence.failedStep.reason)}`);
    own.push(...browserFindings(evidence), ...chipFindings(evidence.chipStates), ...serverStackFindings(evidence.serverOutput));
    findings.push(...own.map((finding) => `${evidence.template}: ${finding}`));
  }
  findings.push(...egressFindings(run.egress));
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
    record({ method: request.method ?? 'GET', host: target?.hostname ?? raw, port: Number(target?.port || 80), allowed: false });
    response.writeHead(403).end(`fresh-install egress guard: only https://${REGISTRY_HOST} may be reached\n`);
  });
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const { host, port: targetPort } = splitHostPort(request.url ?? '');
    const allowed = isRegistryRequest(host, targetPort);
    record({ method: 'CONNECT', host, port: targetPort, allowed });
    if (allowed) tunnel(client, head, host, targetPort);
    else client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}
