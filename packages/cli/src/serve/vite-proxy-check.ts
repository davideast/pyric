/**
 * The Vite plugin checks each `server.proxy` target at start (#2304 G-5).
 *
 * A sandbox page proxied to a backend that is not under pyric, or is in live
 * mode, sends that backend's Firebase calls to production. Each loopback
 * target is asked for its process health (`register/process-health.ts`) once
 * the dev server listens. A target that did not answer is asked again after
 * its first proxied response, through the proxy's `configure` hook, chained
 * to the app's own. The check warns once per target and verdict, and never
 * refuses. The host's `/__pyric/health` lists each verdict as `proxyTargets`.
 */
import http from 'node:http';
import https from 'node:https';
import { PROCESS_HEALTH_HEADER, PROCESS_HEALTH_PATH, type ProcessHealth } from '../register/process-health.js';
import { isLoopbackAddress } from './peer.js';

export type ProxyVerdict = 'same' | 'other-mode' | 'other-instance' | 'other-project' | 'pyric-host' | 'not-pyric';

/** What this dev server's page is. */
export interface HostIdentity {
  readonly mode: 'sandbox' | 'live';
  readonly instanceId?: string;
  readonly projectId?: string;
  /** This dev server's URL, for the warning. */
  readonly url?: string;
}

export interface ProxyTargetReport {
  readonly context: string;
  readonly verdict: ProxyVerdict;
}

export interface ProxyTarget {
  readonly context: string;
  readonly target: string;
}

/** The part of http-proxy's server the check listens on. */
export interface ProxyHook {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type Configure = (proxy: ProxyHook, options: unknown) => void;

/** A target's process health, read from the network, so any field may be missing. */
type ProcessAnswer = Partial<ProcessHealth>;

/** A target's answer: null when it did not answer at all. */
type TargetAnswer = { readonly process?: ProcessAnswer; readonly pyricHost: boolean } | null;

const PROBE_TIMEOUT_MS = 1000;
/** A process health answer is a few hundred bytes; a longer body is not one. */
const MAX_HEALTH_BODY_BYTES = 16 * 1024;

/** The health request's protocol for a proxy target: a WebSocket target is asked over HTTP(S). */
const PROBE_PROTOCOLS: Readonly<Record<string, 'http:' | 'https:'>> = {
  'http:': 'http:',
  'ws:': 'http:',
  'https:': 'https:',
  'wss:': 'https:',
};

function targetOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  const isObject = typeof entry === 'object' && entry !== null;
  const target = isObject ? (entry as { target?: unknown }).target : undefined;
  return typeof target === 'string' ? target : undefined;
}

function isLoopbackUrl(target: string): boolean {
  if (!URL.canParse(target)) return false;
  const hostname = new URL(target).hostname.replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

/** The `server.proxy` targets on this machine; the check covers only these. */
export function loopbackProxyTargets(proxy: Record<string, unknown> | undefined): ProxyTarget[] {
  const targets: ProxyTarget[] = [];
  for (const [context, entry] of Object.entries(proxy ?? {})) {
    const target = targetOf(entry);
    const isLoopback = target !== undefined && isLoopbackUrl(target);
    if (isLoopback) targets.push({ context, target });
  }
  return targets;
}

function parseAnswer(text: string): TargetAnswer {
  try {
    const body = JSON.parse(text) as { pyricProcess?: ProcessAnswer; instanceId?: unknown };
    const backend = typeof body.pyricProcess === 'object' && body.pyricProcess !== null ? body.pyricProcess : undefined;
    return { process: backend, pyricHost: backend === undefined && typeof body.instanceId === 'string' };
  } catch {
    return { pyricHost: false };
  }
}

function healthUrl(target: string): URL | null {
  const parsed = new URL(target);
  const protocol = PROBE_PROTOCOLS[parsed.protocol];
  if (protocol === undefined) return null;
  return new URL(`${protocol}//${parsed.host}${PROCESS_HEALTH_PATH}`);
}

function readAnswer(response: http.IncomingMessage, resolve: (answer: TargetAnswer) => void): void {
  let text = '';
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    text += chunk;
    const isTooLong = text.length > MAX_HEALTH_BODY_BYTES;
    if (isTooLong) {
      resolve({ pyricHost: false });
      response.destroy();
    }
  });
  response.on('end', () => resolve(response.statusCode === 200 ? parseAnswer(text) : { pyricHost: false }));
  response.on('error', () => resolve({ pyricHost: false }));
}

/**
 * Asks one target for its process health. Any HTTP answer counts as
 * answered. Never rejects: a target it cannot ask reads as no answer.
 */
export function probeProxyTarget(target: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<TargetAnswer> {
  return new Promise((resolve) => {
    try {
      const url = healthUrl(target);
      if (url === null) {
        resolve(null);
        return;
      }
      const options = { headers: { [PROCESS_HEALTH_HEADER]: '1' }, timeout: timeoutMs };
      const onResponse = (response: http.IncomingMessage): void => readAnswer(response, resolve);
      // A loopback dev backend's certificate is usually self-signed.
      const request = url.protocol === 'https:'
        ? https.get(url, { ...options, rejectUnauthorized: false }, onResponse)
        : http.get(url, options, onResponse);
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function differs(ours: string | undefined, theirs: string | undefined): boolean {
  return ours !== undefined && theirs !== undefined && ours !== theirs;
}

/** What a target is, relative to this host. */
export function proxyVerdict(answer: TargetAnswer, host: HostIdentity): ProxyVerdict {
  if (answer?.pyricHost === true) return 'pyric-host';
  const backend = answer?.process;
  if (backend === undefined) return 'not-pyric';
  if (backend.mode !== host.mode) return 'other-mode';
  const isSandbox = host.mode === 'sandbox';
  if (isSandbox && differs(host.instanceId, backend.instanceId)) return 'other-instance';
  if (!isSandbox && differs(host.projectId, backend.projectId)) return 'other-project';
  return 'same';
}

function warningFor(target: ProxyTarget, verdict: ProxyVerdict, answer: TargetAnswer, host: HostIdentity): string | null {
  const lead = `pyric: ${target.context} proxies to ${target.target}`;
  const thisUrl = host.url ?? '<this url>';
  const backendProject = answer?.process?.projectId ?? 'its project';
  const isSandbox = host.mode === 'sandbox';
  const reachesProduction = isSandbox && (verdict === 'not-pyric' || verdict === 'other-mode');
  if (reachesProduction) {
    const what = verdict === 'not-pyric' ? 'not under pyric' : `in live mode for ${backendProject}`;
    return `${lead}, which is ${what}. This page is a sandbox, so that backend's calls may reach production. Start it with pyric run --sandbox ${thisUrl}.`;
  }
  if (verdict === 'other-instance') {
    return `${lead}, which runs against another pyric sandbox (instance ${answer?.process?.instanceId}). Start it with pyric run --sandbox ${thisUrl}.`;
  }
  if (verdict === 'other-mode') {
    return `${lead}, which runs on a pyric sandbox. This page is live, so that backend's calls reach the sandbox. Start it under @pyric/live/register.`;
  }
  if (verdict === 'other-project') {
    return `${lead}, which is in live mode for ${backendProject}. This page is live for ${host.projectId}.`;
  }
  return null;
}

export interface ProxyCheck {
  /** Asks every loopback target; a target that already answered keeps its verdict. */
  checkAll(): Promise<void>;
  /** Resolves when every pending check is done. */
  settled(): Promise<void>;
  report(): ProxyTargetReport[];
}

interface TargetState {
  readonly target: ProxyTarget;
  verdict: ProxyVerdict;
  answered: boolean;
}

function chainConfigure(entry: unknown, onProxyResponse: () => void): unknown {
  const options = typeof entry === 'string' ? { target: entry, changeOrigin: true } : (entry as Record<string, unknown>);
  const appConfigure = options.configure as Configure | undefined;
  const configure: Configure = (proxy, proxyOptions) => {
    appConfigure?.(proxy, proxyOptions);
    proxy.on('proxyRes', onProxyResponse);
  };
  return { ...options, configure };
}

/**
 * Builds the check over `proxy` (the dev server's `server.proxy`, before Vite
 * creates its proxy middleware), and chains a `configure` hook onto each
 * loopback entry so a target that did not answer is asked again.
 */
export function createProxyCheck(input: {
  proxy: Record<string, unknown> | undefined;
  host: () => HostIdentity;
  warn: (line: string) => void;
  timeoutMs?: number;
}): ProxyCheck {
  const states = loopbackProxyTargets(input.proxy).map((target): TargetState => ({ target, verdict: 'not-pyric', answered: false }));
  const warned = new Set<string>();
  const pending = new Set<Promise<void>>();

  const check = async (state: TargetState, warnsUnanswered: boolean): Promise<void> => {
    const answer = await probeProxyTarget(state.target.target, input.timeoutMs);
    const host = input.host();
    state.answered = answer !== null;
    state.verdict = proxyVerdict(answer, host);
    const holdsWarning = !state.answered && !warnsUnanswered;
    if (holdsWarning) return;
    const key = `${state.target.context}\n${state.verdict}`;
    const line = warningFor(state.target, state.verdict, answer, host);
    if (line === null || warned.has(key)) return;
    warned.add(key);
    input.warn(line);
  };

  const track = (work: Promise<void>): Promise<void> => {
    pending.add(work);
    return work.finally(() => pending.delete(work));
  };

  for (const state of states) {
    let rechecked = false;
    const recheck = (): void => {
      const skips = rechecked || state.answered;
      if (skips) return;
      rechecked = true;
      track(check(state, true)).catch(() => {});
    };
    const proxy = input.proxy as Record<string, unknown>;
    proxy[state.target.context] = chainConfigure(proxy[state.target.context], recheck);
  }

  return {
    async checkAll() {
      const unanswered = states.filter((state) => !state.answered);
      await Promise.all(unanswered.map((state) => track(check(state, false))));
    },
    async settled() {
      await Promise.all([...pending]);
    },
    report: () => states.map((state) => ({ context: state.target.context, verdict: state.verdict })),
  };
}

const reports = new Map<string, () => readonly ProxyTargetReport[]>();

/** Lists a dev server's verdicts in the health of the host with `instanceId`; returns the remover. */
export function reportProxyTargets(instanceId: string, report: () => readonly ProxyTargetReport[]): () => void {
  reports.set(instanceId, report);
  return () => {
    if (reports.get(instanceId) === report) reports.delete(instanceId);
  };
}

/** The verdicts reported for the host with `instanceId`, or undefined when none were. */
export function proxyTargetsOf(instanceId: string): readonly ProxyTargetReport[] | undefined {
  return reports.get(instanceId)?.();
}

/** The parts of Vite's dev server the check reads. */
export interface ProxyCheckServer {
  readonly config: {
    server: { proxy?: Record<string, unknown> };
    logger: { warn(line: string, options?: { timestamp?: boolean }): void };
  };
  readonly httpServer: { once(event: 'listening', listener: () => void): unknown } | null;
  readonly resolvedUrls?: { local: string[] } | null;
}

/**
 * Checks `server`'s proxy targets once it listens, as a page of `identity`'s
 * mode, instance and project, and lists the verdicts in that host's health.
 * Runs from `configureServer`, before Vite builds its proxy middleware.
 * Returns the remover for the health listing.
 */
export function attachViteProxyCheck(
  server: ProxyCheckServer,
  identity: { mode: HostIdentity['mode']; instanceId?: string; projectId?: string },
): () => void {
  const proxy = server.config.server.proxy;
  const httpServer = server.httpServer;
  const hasTargets = loopbackProxyTargets(proxy).length > 0;
  if (!hasTargets || httpServer === null) return () => {};
  const check = createProxyCheck({
    proxy,
    host: () => ({ ...identity, url: server.resolvedUrls?.local[0] }),
    warn: (line) => server.config.logger.warn(line, { timestamp: true }),
  });
  httpServer.once('listening', () => { check.checkAll().catch(() => {}); });
  const instanceId = identity.instanceId;
  if (instanceId === undefined) return () => {};
  return reportProxyTargets(instanceId, () => check.report());
}
