/**
 * The builder recorder's browser layer: reads the NetLog Chromium writes with
 * `--log-net-log`. A NetLog sees every request the network service makes,
 * including what `context.route` misses (#1606): WebSockets, which the real
 * RTDB SDK opens to `*.firebaseio.com`, and a service worker's own fetches.
 *
 * Chromium writes the constants on the first line, then `"events": [`, then
 * one event per line. It flushes events when the browser closes, so the
 * harness reads the file after the browser server stops. A browser that was
 * killed leaves the array unterminated; the reader takes every whole line.
 */
import { classifyHost, type HostClass } from './google-hosts.ts';

/** The NetLog constants this reader uses, name to number. */
export interface NetLogConstants {
  logEventTypes: Record<string, number>;
  logSourceType: Record<string, number>;
  logEventPhase: Record<string, number>;
  netError?: Record<string, number>;
}

/** One NetLog event as Chromium writes it. */
export interface NetLogEvent {
  type: number;
  phase: number;
  source: { id: number; type: number };
  params?: Record<string, unknown>;
}

export interface NetLog {
  constants: NetLogConstants;
  events: NetLogEvent[];
}

/** A request the browser made: a page or worker fetch, a subresource, a WebSocket handshake. */
export interface BrowserRequest extends HostClass {
  layer: 'browser';
  kind: 'request';
  via: 'netlog';
  /** The NetLog source id, the same for every leg of one request. */
  source: number;
  url: string;
  method?: string;
  /** Chromium's net error code: 0 when the request completed, null when the log ends first. */
  netError: number | null;
  netErrorName?: string;
}

/** A socket the browser opened toward an address. */
export interface BrowserConnect extends HostClass {
  layer: 'browser';
  kind: 'connect';
  via: 'netlog';
  source: number;
  protocol: 'tcp' | 'udp';
  address: string;
  port: number;
}

export type BrowserEvent = BrowserRequest | BrowserConnect;

const EVENTS_HEADER = /\n\s*"events"\s*:\s*\[/;

/** Parses a NetLog, whole or cut short. */
export function readNetLog(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    return readUnterminatedNetLog(text);
  }
}

function readUnterminatedNetLog(text: string): NetLog {
  const header = EVENTS_HEADER.exec(text);
  if (header === null) throw new Error('not a NetLog: no "events" array after the constants');
  const constantsText = `${text.slice(0, header.index).trim().replace(/,$/, '')}}`;
  const { constants } = JSON.parse(constantsText) as { constants: NetLogConstants };
  const events: NetLogEvent[] = [];
  for (const line of text.slice(header.index + header[0].length).split('\n')) {
    const event = parsedEventLine(line);
    if (event !== undefined) events.push(event);
  }
  return { constants, events };
}

/** One event line, or undefined for the closing lines and a half-written last line. */
function parsedEventLine(line: string): NetLogEvent | undefined {
  const trimmed = line.trim().replace(/,$/, '');
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as NetLogEvent;
  } catch {
    return undefined;
  }
}

/** Numbers to names for one constants table. */
function invert(table: Record<string, number> | undefined): Map<number, string> {
  return new Map(Object.entries(table ?? {}).map(([name, value]) => [value, name]));
}

interface Names {
  event: Map<number, string>;
  source: Map<number, string>;
  phase: Map<number, string>;
  netError: Map<number, string>;
}

function namesOf(constants: NetLogConstants): Names {
  return {
    event: invert(constants.logEventTypes),
    source: invert(constants.logSourceType),
    phase: invert(constants.logEventPhase),
    netError: invert(constants.netError),
  };
}

/** One leg of a request: the URL a job started for, and how the job ended. */
interface RequestLeg {
  url: string;
  method?: string;
  netError: number | null;
}

/** What the reader gathers for one URL_REQUEST source. */
interface RequestSource {
  aliveUrl?: string;
  aliveError: number | null;
  legs: RequestLeg[];
}

function stringParam(event: NetLogEvent, name: string): string | undefined {
  const value = event.params?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** The `net_error` an END event carries; an END without one completed. */
function endError(event: NetLogEvent): number {
  const value = event.params?.net_error;
  return typeof value === 'number' ? value : 0;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** `127.0.0.1:443` or `[2001:db8::1]:443` as host and port. */
export function splitAddress(address: string): { host: string; port: number } {
  const bracketed = /^\[(.*)\]:(\d+)$/.exec(address);
  if (bracketed !== null) return { host: bracketed[1]!, port: Number(bracketed[2]) };
  const separator = address.lastIndexOf(':');
  if (separator === -1) return { host: address, port: 0 };
  return { host: address.slice(0, separator), port: Number(address.slice(separator + 1)) };
}

function errorName(names: Names, code: number | null): string | undefined {
  if (code === null || code === 0) return undefined;
  const name = names.netError.get(code);
  if (name === undefined) return undefined;
  return name.startsWith('ERR_') ? name : `ERR_${name}`;
}

/** Applies one URL_REQUEST event to what is known about its source. */
function readRequestEvent(request: RequestSource, eventName: string | undefined, phase: string | undefined, event: NetLogEvent): void {
  const isBegin = phase === 'PHASE_BEGIN';
  const isEnd = phase === 'PHASE_END';
  if (eventName === 'REQUEST_ALIVE' && isBegin) request.aliveUrl = stringParam(event, 'url');
  if (eventName === 'REQUEST_ALIVE' && isEnd) request.aliveError = endError(event);
  if (eventName === 'URL_REQUEST_START_JOB' && isBegin) {
    request.legs.push({ url: stringParam(event, 'url') ?? '', method: stringParam(event, 'method'), netError: null });
  }
  const leg = request.legs.at(-1);
  if (eventName === 'URL_REQUEST_START_JOB' && isEnd && leg !== undefined) leg.netError = endError(event);
}

/** Each leg of each request, ending as the request ended when a leg has no end of its own. */
function requestEvents(sources: Map<number, RequestSource>, names: Names): BrowserRequest[] {
  const requests: BrowserRequest[] = [];
  for (const [source, request] of sources) {
    const legs = request.legs.length > 0 ? request.legs : [{ url: request.aliveUrl ?? '', netError: null }];
    for (const leg of legs) {
      const netError = leg.netError ?? request.aliveError;
      const name = errorName(names, netError);
      requests.push({
        layer: 'browser',
        kind: 'request',
        via: 'netlog',
        source,
        url: leg.url,
        ...(leg.method === undefined ? {} : { method: leg.method }),
        netError,
        ...(name === undefined ? {} : { netErrorName: name }),
        ...classifyHost(hostOfUrl(leg.url)),
      });
    }
  }
  return requests;
}

/** The socket connect events and the protocol each one opens. */
const CONNECT_EVENTS: ReadonlyMap<string, 'tcp' | 'udp'> = new Map([
  ['TCP_CONNECT_ATTEMPT', 'tcp'],
  ['UDP_CONNECT', 'udp'],
]);

function connectEvent(event: NetLogEvent, protocol: 'tcp' | 'udp'): BrowserConnect | undefined {
  const address = stringParam(event, 'address');
  if (address === undefined) return undefined;
  const { host, port } = splitAddress(address);
  return { layer: 'browser', kind: 'connect', via: 'netlog', source: event.source.id, protocol, address, port, ...classifyHost(host) };
}

/**
 * The requests and socket connects in a NetLog. Host resolution events are
 * left out: under the harness's resolver rules they name the mapped host
 * (`~notfound`), not the one the page asked for.
 */
export function browserEvents(log: NetLog): BrowserEvent[] {
  const names = namesOf(log.constants);
  const sources = new Map<number, RequestSource>();
  const connects: BrowserConnect[] = [];
  for (const event of log.events) {
    const eventName = names.event.get(event.type);
    const phase = names.phase.get(event.phase);
    const protocol = eventName === undefined ? undefined : CONNECT_EVENTS.get(eventName);
    const isConnectBegin = protocol !== undefined && phase === 'PHASE_BEGIN';
    if (isConnectBegin) {
      const connect = connectEvent(event, protocol);
      if (connect !== undefined) connects.push(connect);
    }
    if (names.source.get(event.source.type) !== 'URL_REQUEST') continue;
    const request = sources.get(event.source.id) ?? { aliveError: null, legs: [] };
    sources.set(event.source.id, request);
    readRequestEvent(request, eventName, phase, event);
  }
  return [...requestEvents(sources, names), ...connects];
}
