/**
 * The handshake beacon: register's proof-of-life that interception is actually
 * installed in this child.
 *
 * Two channels, deliberately:
 *   - a fire-and-forget POST to the dev server's `/__pyric/beacon` when the
 *     bridge URL is knowable from the child's own env (`PYRIC_SANDBOX`, which
 *     `cli/sandbox-runner.ts:buildChildEnv` sets to `remote:<url>`), carrying
 *     the per-launch secret from `PYRIC_BEACON_TOKEN`;
 *   - one structured stderr line, printed only when the developer asked for
 *     detail or when the report itself is bad news.
 *
 * The POST must never be able to break the child: an unreachable host, a
 * rejecting server, or a sender that throws synchronously all have to be
 * swallowed.
 */
import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import {
  BEACON_PATH,
  BEACON_TOKEN_HEADER,
  beaconEndpoint,
  beaconLineIsPrinted,
  emitBeacon,
  formatBeaconLine,
  sendBeaconRequest,
  type BeaconReport,
} from '../../src/register/beacon.js';

const report: BeaconReport = {
  pid: 4242,
  guard: 'warn',
  hooks: true,
  sandbox: 'remote:http://127.0.0.1:5000',
};

/** The child env a launched process sees, with the stderr line switched on so
 *  the tests that assert on it get one. */
const verboseEnv = { PYRIC_BEACON_TOKEN: 'launch-secret', PYRIC_DEBUG: '1' };

describe('beaconEndpoint', () => {
  it('derives the endpoint from the remote: activator', () => {
    expect(beaconEndpoint('remote:http://127.0.0.1:5000')).toBe(
      `http://127.0.0.1:5000${BEACON_PATH}`,
    );
  });

  it('tolerates a trailing slash on the serve url', () => {
    expect(beaconEndpoint('remote:http://localhost:3473/')).toBe(
      `http://localhost:3473${BEACON_PATH}`,
    );
  });

  it('accepts a bare http url activator (no remote: prefix)', () => {
    expect(beaconEndpoint('http://127.0.0.1:5000')).toBe(`http://127.0.0.1:5000${BEACON_PATH}`);
  });

  it('returns null when no bridge url is knowable', () => {
    expect(beaconEndpoint(undefined)).toBeNull();
    expect(beaconEndpoint('')).toBeNull();
    expect(beaconEndpoint('local')).toBeNull();
    expect(beaconEndpoint('remote:')).toBeNull();
    // Non-http schemes are not fetchable, so never guess.
    expect(beaconEndpoint('remote:ws://127.0.0.1:5000')).toBeNull();
    expect(beaconEndpoint('remote:not a url')).toBeNull();
  });
});

describe('formatBeaconLine', () => {
  it('leads with fixed machine-parseable fields', () => {
    const line = formatBeaconLine(report, `http://127.0.0.1:5000${BEACON_PATH}`);
    expect(line.startsWith('@pyric/cli/register: beacon ACTIVE pid=4242 guard=warn hooks=1 ')).toBe(
      true,
    );
    expect(line).toContain('bridge=http://127.0.0.1:5000/__pyric/beacon');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('reports hooks=0 and bridge=none honestly', () => {
    const line = formatBeaconLine({ ...report, hooks: false, guard: 'off' }, null);
    expect(line).toContain('guard=off');
    expect(line).toContain('hooks=0');
    expect(line).toContain('bridge=none');
  });
});

/**
 * The stderr channel is quiet on a healthy default run: a first run should not
 * carry one line per launched process when the POST already told the dev
 * server what happened.
 */
describe('beaconLineIsPrinted', () => {
  it('is silent for a healthy child under the default env', () => {
    expect(beaconLineIsPrinted(report, {})).toBe(false);
    expect(beaconLineIsPrinted(report, { PYRIC_GUARD: '' })).toBe(false);
    expect(beaconLineIsPrinted(report, { PYRIC_GUARD: '   ' })).toBe(false);
  });

  it('prints when the developer asked for detail', () => {
    expect(beaconLineIsPrinted(report, { PYRIC_GUARD: 'block' })).toBe(true);
    expect(beaconLineIsPrinted(report, { PYRIC_GUARD: 'warn' })).toBe(true);
    expect(beaconLineIsPrinted(report, { PYRIC_DEBUG: '1' })).toBe(true);
    expect(beaconLineIsPrinted(report, { PYRIC_VERBOSE: '1' })).toBe(true);
  });

  it('prints regardless when the hooks did not install', () => {
    expect(beaconLineIsPrinted({ ...report, hooks: false }, {})).toBe(true);
  });
});

describe('emitBeacon', () => {
  it('sends the report as JSON with the launch secret', () => {
    const lines: string[] = [];
    const sent: Array<{ endpoint: string; body: string; token: string }> = [];
    emitBeacon(report, {
      env: verboseEnv,
      write: (line) => lines.push(line),
      send: (endpoint, body, token) => sent.push({ endpoint, body, token }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pid=4242');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.endpoint).toBe(`http://127.0.0.1:5000${BEACON_PATH}`);
    expect(sent[0]!.token).toBe('launch-secret');
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      pid: 4242,
      guard: 'warn',
      hooks: true,
      sandbox: 'remote:http://127.0.0.1:5000',
    });
  });

  it('still POSTs when the stderr line is suppressed', () => {
    const lines: string[] = [];
    let sends = 0;
    emitBeacon(report, {
      env: { PYRIC_BEACON_TOKEN: 'launch-secret' },
      write: (line) => lines.push(line),
      send: () => { sends += 1; },
    });
    expect(lines).toEqual([]);
    expect(sends).toBe(1);
  });

  it('sends an empty token when the launcher set none', () => {
    const sent: string[] = [];
    emitBeacon(report, {
      env: {},
      write: () => {},
      send: (_endpoint, _body, token) => sent.push(token),
    });
    expect(sent).toEqual(['']);
  });

  it('skips the send when no bridge url is knowable, but still writes the line', () => {
    const lines: string[] = [];
    let sent = false;
    emitBeacon(
      { ...report, sandbox: 'local' },
      {
        env: verboseEnv,
        write: (line) => lines.push(line),
        send: () => { sent = true; },
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bridge=none');
    expect(sent).toBe(false);
  });

  it('swallows a throwing sender, so the stderr line still stands', () => {
    const lines: string[] = [];
    expect(() =>
      emitBeacon(report, {
        env: verboseEnv,
        write: (line) => lines.push(line),
        send: () => {
          throw new Error('no http here');
        },
      }),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

/**
 * The default sender must not keep a process alive, so it is a raw `node:http`
 * request over an unref'd socket rather than `fetch`.
 */
describe('sendBeaconRequest', () => {
  it('POSTs the body to the endpoint', async () => {
    const received: Array<{ url: string; method: string; body: string; token: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { raw += c; });
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          method: req.method ?? '',
          body: raw,
          token: String(req.headers[BEACON_TOKEN_HEADER] ?? ''),
        });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      sendBeaconRequest(
        `http://127.0.0.1:${port}${BEACON_PATH}`,
        JSON.stringify(report),
        'launch-secret',
      );
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe('POST');
      expect(received[0]!.url).toBe(BEACON_PATH);
      expect(JSON.parse(received[0]!.body)).toMatchObject({ pid: 4242 });
      expect(received[0]!.token).toBe('launch-secret');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never throws at a refused endpoint', () => {
    // Port 1 is reliably not listening.
    expect(() =>
      sendBeaconRequest(`http://127.0.0.1:1${BEACON_PATH}`, '{}', 'launch-secret'),
    ).not.toThrow();
  });
});
