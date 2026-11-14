/**
 * Which error responses from `/__pyric/` routes fail an app (host-errors.ts).
 * A host here is a stand-in that says when it was asked to stop and when it
 * was gone; the times are plain numbers on one clock.
 */
import { describe, expect, test } from 'bun:test';
import { HostErrors, responseTimes, type ResponseTimes, type StoppableHost } from './host-errors.ts';

const PORT = 5173;
const DIAGNOSTICS = `http://127.0.0.1:${PORT}/__pyric/diagnostics`;

function host(times: { stopRequestedAt?: number; exitedAt?: number } = {}): StoppableHost {
  return { stopRequestedAt: times.stopRequestedAt, exitedAt: times.exitedAt };
}

/** One request/response pair that started `lead` ms before the response arrived. */
function at(answeredAt: number, lead = 1): ResponseTimes {
  return { startedAt: answeredAt - lead, answeredAt };
}

/** One 404 to a page's diagnostics post, recorded during the step "serve". */
function record404(errors: HostErrors, times: ResponseTimes | undefined, href = DIAGNOSTICS) {
  return errors.record('serve', { status: 404, method: 'POST', href, times });
}

describe('an error a running host answers', () => {
  test('fails the app when its host was never asked to stop', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host());
    expect(record404(errors, at(1_000)).kind).toBe('counted');
    expect(errors.unexpected()).toEqual(['404 POST /__pyric/diagnostics (during "serve")']);
  });

  test('fails the app when the host answered before the scenario asked it to stop', () => {
    const errors = new HostErrors();
    // Read later, with the stop already requested: the answer's own time decides.
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000 }));
    expect(record404(errors, at(1_999)).kind).toBe('counted');
    expect(errors.unexpected()).toEqual(['404 POST /__pyric/diagnostics (during "serve")']);
  });

  test('fails the app with any status and route, such as a 500 from the health route', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host());
    errors.record('serve', { status: 500, method: 'GET', href: `http://127.0.0.1:${PORT}/__pyric/health`, times: at(1_000) });
    expect(errors.unexpected()).toEqual(['500 GET /__pyric/health (during "serve")']);
  });
});

describe('an error a host answers while the scenario stops it', () => {
  test('does not count 404 or 503 between the stop request and the exit', () => {
    const errors = new HostErrors();
    const stopping = { stopRequestedAt: 2_000, exitedAt: undefined as number | undefined };
    errors.servedBy(PORT, stopping);
    expect(record404(errors, at(2_000)).kind).toBe('from-stopping-host');
    expect(record404(errors, at(2_150)).kind).toBe('from-stopping-host');
    expect(errors.record('serve', { status: 503, method: 'GET', href: `http://127.0.0.1:${PORT}/__pyric/health`, times: at(2_200) }).kind).toBe('from-stopping-host');
    // A response buffered in the loopback socket can arrive in the browser right after the child exited.
    stopping.exitedAt = 2_300;
    expect(record404(errors, { startedAt: 2_299.6, answeredAt: 2_303 }).kind).toBe('from-stopping-host');
    expect(errors.unexpected()).toEqual([]);
  });

  test('still fails the app on a 500, 403, or 401 even while the host is stopping', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000 }));
    expect(errors.record('serve', { status: 500, method: 'POST', href: DIAGNOSTICS, times: at(2_100) }).kind).toBe('counted');
    expect(errors.record('serve', { status: 403, method: 'POST', href: DIAGNOSTICS, times: at(2_100) }).kind).toBe('counted');
    expect(errors.record('serve', { status: 401, method: 'GET', href: `http://127.0.0.1:${PORT}/__pyric/health`, times: at(2_100) }).kind).toBe('counted');
    expect(errors.unexpected()).toEqual([
      '500 POST /__pyric/diagnostics (during "serve")',
      '403 POST /__pyric/diagnostics (during "serve")',
      '401 GET /__pyric/health (during "serve")',
    ]);
  });

  test('counts again for requests started after the process exited: a later process on the same port answers for itself', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000, exitedAt: 2_300 }));
    expect(record404(errors, { startedAt: 2_301, answeredAt: 2_305 }).kind).toBe('counted');
    expect(errors.unexpected()).toEqual(['404 POST /__pyric/diagnostics (during "serve")']);
  });

  test('counts for the replacement the driver started on the same port, which nobody stopped', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000, exitedAt: 2_300 }));
    errors.servedBy(PORT, host());
    expect(record404(errors, at(2_100)).kind).toBe('counted');
  });

  test('counts when the browser did not time the answer', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000 }));
    expect(record404(errors, undefined).kind).toBe('counted');
  });

  test('counts from a port the driver started no host on, a non-loopback host, and another host that is not stopping', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000 }));
    errors.servedBy(5174, host());
    expect(record404(errors, at(2_100), 'http://127.0.0.1:4000/__pyric/diagnostics').kind).toBe('counted');
    expect(record404(errors, at(2_100), `http://example.test:${PORT}/__pyric/diagnostics`).kind).toBe('counted');
    expect(record404(errors, at(2_100), 'http://127.0.0.1:5174/__pyric/diagnostics').kind).toBe('counted');
    expect(errors.unexpected()).toHaveLength(3);
  });

  test('does not satisfy an expectHostError pattern, so a pattern only it would match is still stale', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host({ stopRequestedAt: 2_000 }));
    errors.expect(/^404 POST \/__pyric\/diagnostics$/);
    record404(errors, at(2_100));
    expect(errors.unexpected()).toEqual([
      'expectHostError(/^404 POST \\/__pyric\\/diagnostics$/) matched no error response from a /__pyric/ route; remove it or fix its pattern',
    ]);
  });
});

describe('a response that is not from a host route', () => {
  test('is not a host error, whatever its host is doing', () => {
    const errors = new HostErrors();
    errors.servedBy(PORT, host());
    expect(errors.record('serve', { status: 404, method: 'GET', href: `http://127.0.0.1:${PORT}/missing.png`, times: at(1_000) }).kind).toBe('not-a-host-route');
    expect(errors.unexpected()).toEqual([]);
  });
});

describe('responseTimes', () => {
  test('returns the wall-clock start and response times', () => {
    expect(responseTimes({ startTime: 1_700_000_000_000, responseStart: 12.5 })).toEqual({
      startedAt: 1_700_000_000_000,
      answeredAt: 1_700_000_000_012.5,
    });
  });

  test('is undefined when the browser did not time the response or the request', () => {
    expect(responseTimes({ startTime: 1_700_000_000_000, responseStart: -1 })).toBeUndefined();
    expect(responseTimes({ startTime: 0, responseStart: 3 })).toBeUndefined();
    expect(responseTimes({ startTime: -1, responseStart: 3 })).toBeUndefined();
  });
});
