/**
 * The error responses the `/__pyric/` routes gave an app's pages, and which
 * of them fail the app.
 *
 * Every such response fails the app after its scenario unless an
 * `expectHostError` pattern allows it, and so does a pattern that matched
 * nothing, with one exception: a 404 or 503 a host gave after the scenario
 * asked that host's process to stop, for a request the browser started
 * before the process was gone. A host that is shutting down disposes its
 * generation middleware while its HTTP listener still accepts connections:
 * health answers 503 and every other `/__pyric/` route falls through to
 * Vite's 404. A request a page makes in that window, such as the connection
 * report it posts when its socket drops, gets that closing status. That
 * answer says the host is going away, which the scenario asked for. The
 * check guards the routes of a host that is serving: the runner already
 * reads it before it closes the run's own processes.
 *
 * The exception needs proof of all four facts: the status is one a closing
 * host produces (404 or 503, never a 500 or 403), the driver knows which
 * local process serves the response's port, the scenario called `stop()` on
 * it, and the browser timed the response after the stop request from a
 * request started before the process exited. A response with no timing, from
 * a non-loopback host or a port the driver did not start a host on, from a
 * process nobody stopped, with a non-closing status, or started after the
 * process exited counts as before.
 */

/** An error response from a `/__pyric/` route, with the step it happened in and, once read, the first line of its body. */
export interface HostError {
  step: string;
  request: string;
  body?: string;
}

/** What the exception reads of the process that serves a port. */
export interface StoppableHost {
  /** When `stop()` first found the process running, by `Date.now()`. */
  readonly stopRequestedAt: number | undefined;
  /** When the driver saw the process gone, by `Date.now()`. */
  readonly exitedAt: number | undefined;
}

/** Wall-clock times a browser recorded for one request and its response headers. */
export interface ResponseTimes {
  /** When the browser started the request, by its wall clock. */
  startedAt: number;
  /** When the browser received the response headers, by its wall clock. */
  answeredAt: number;
}

export interface ErrorResponse {
  status: number;
  method: string;
  href: string;
  /** When the browser sent the request and received the response, when it timed them. */
  times?: ResponseTimes;
}

/** What the browser log says of an error response that does not count because its host was stopping. */
export const STOPPING_HOST_NOTE = ', from a host the scenario was stopping, not counted';

/** The only statuses a closing Pyric host produces when its routes tear down ahead of its listener. */
const CLOSING_HOST_STATUSES = new Set([404, 503]);

/** Hostnames that refer to the local machine where the driver starts host processes. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * When the browser started a request and received its response headers, from
 * its resource timing: `startTime` is wall-clock milliseconds, and
 * `responseStart` is relative to it, or negative when the browser did not
 * time the response.
 */
export function responseTimes(timing: { startTime: number; responseStart: number }): ResponseTimes | undefined {
  const isTimed = timing.startTime > 0 && timing.responseStart >= 0;
  if (!isTimed) return undefined;
  return { startedAt: timing.startTime, answeredAt: timing.startTime + timing.responseStart };
}

/** The first line of a response body that has text, cut to 200 characters. */
export function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  return line.slice(0, 200);
}

/**
 * A `mayNotHappen` reason lets an allowance match nothing, so it must say why
 * and cite the issue that tracks the race, which closing ends the allowance.
 */
function assertCitesIssue(pattern: RegExp, reason: string): void {
  const hasReason = reason.trim().length > 0;
  const citesIssue = /#\d+/.test(reason);
  if (hasReason && citesIssue) return;
  throw new Error(`expectHostError(${pattern}): mayNotHappen must say why the error comes only in some runs and cite its issue (#<number>); got ${JSON.stringify(reason)}`);
}

/**
 * Whether `host` answered `times` while stopping: the response arrived at or
 * after `stopRequestedAt`, and the request started before `exitedAt` (so a
 * response buffered in the loopback socket when the child exited still
 * matches, while a request to a later process on the same port does not).
 */
function answeredWhileStopping(host: StoppableHost, times: ResponseTimes): boolean {
  const stopRequestedAt = host.stopRequestedAt;
  if (stopRequestedAt === undefined) return false;
  const answeredAfterStop = times.answeredAt >= stopRequestedAt;
  const startedBeforeExit = host.exitedAt === undefined || Math.floor(times.startedAt) <= host.exitedAt;
  return answeredAfterStop && startedBeforeExit;
}

/** How a recorded error response counts. */
export type HostErrorVerdict =
  | { kind: 'not-a-host-route' }
  | { kind: 'from-stopping-host' }
  | { kind: 'counted'; error: HostError };

function formatHostError({ step, request, body }: HostError): string {
  const base = `${request} (during "${step}")`;
  if (body) return `${base}: ${body}`;
  return base;
}

export class HostErrors {
  private readonly errors: HostError[] = [];
  private readonly expected: RegExp[] = [];
  /** The `expectHostError` patterns whose error comes only in some runs, which the stale check skips. */
  private readonly racy = new Set<RegExp>();
  /** The process the driver started to serve each port, the latest one when a port is served again. */
  private readonly hosts = new Map<number, StoppableHost>();

  /** Records that the driver started `host` to serve `port`. */
  servedBy(port: number, host: StoppableHost): void {
    this.hosts.set(port, host);
  }

  expect(pattern: RegExp, options: { mayNotHappen?: string } = {}): void {
    const reason = options.mayNotHappen;
    const isRacy = reason !== undefined;
    if (isRacy) assertCitesIssue(pattern, reason);
    this.expected.push(pattern);
    if (isRacy) this.racy.add(pattern);
  }

  /** Records an error response a page received during `step`; only `/__pyric/` routes count as host errors. */
  record(step: string, response: ErrorResponse): HostErrorVerdict {
    const url = new URL(response.href);
    const isHostRoute = url.pathname.startsWith('/__pyric/');
    if (!isHostRoute) return { kind: 'not-a-host-route' };
    if (this.isFromStoppingHost(url, response.status, response.times)) return { kind: 'from-stopping-host' };
    const error: HostError = { step, request: `${response.status} ${response.method} ${url.pathname}${url.search}` };
    this.errors.push(error);
    return { kind: 'counted', error };
  }

  private isFromStoppingHost(url: URL, status: number, times: ResponseTimes | undefined): boolean {
    const isClosingStatus = CLOSING_HOST_STATUSES.has(status);
    if (!isClosingStatus) return false;
    if (times === undefined) return false;
    if (!LOCAL_HOSTS.has(url.hostname)) return false;
    if (url.port.length === 0) return false;
    const host = this.hosts.get(Number(url.port));
    if (host === undefined) return false;
    return answeredWhileStopping(host, times);
  }

  /**
   * What fails the app after its scenario: each counted error that no
   * `expectHostError` pattern matches, then each pattern that matched no
   * error. A pattern that matched nothing fails the run as an
   * `expectedCrashes` entry does (crash-watch.ts), so the list cannot outlive
   * what it describes.
   */
  unexpected(): string[] {
    const unexpected = this.errors
      .filter(({ request }) => !this.expected.some((pattern) => pattern.test(request)))
      .map(formatHostError);
    const stale = this.expected
      .filter((pattern) => !this.racy.has(pattern))
      .filter((pattern) => !this.errors.some(({ request }) => pattern.test(request)))
      .map((pattern) => `expectHostError(${pattern}) matched no error response from a /__pyric/ route; remove it or fix its pattern`);
    return [...unexpected, ...stale];
  }
}
