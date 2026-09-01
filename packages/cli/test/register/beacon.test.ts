/**
 * TA.4-A — the HANDSHAKE BEACON: register's proof-of-life that interception
 * is actually installed in this child.
 *
 * Two channels, deliberately:
 *   - a single structured stderr line, ALWAYS (the fallback a parent can
 *     scrape out of the `[dev] `-prefixed child stream);
 *   - a fire-and-forget POST to the dev server's `/__pyric/beacon` when the
 *     bridge URL is knowable from the child's own env (`PYRIC_SANDBOX`,
 *     which `cli/sandbox-runner.ts:buildChildEnv` sets to `remote:<url>`).
 *
 * The POST must never be able to break the child: an unreachable host, a
 * rejecting server, or a `fetch` that throws synchronously all have to be
 * swallowed, and the stderr line still has to be written.
 */
import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import {
  BEACON_PATH,
  beaconEndpoint,
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
    // Non-http schemes are not fetchable — never guess.
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

describe('emitBeacon', () => {
  it('always writes the stderr line and sends the report as JSON', () => {
    const lines: string[] = [];
    const sent: Array<{ endpoint: string; body: string }> = [];
    emitBeacon(report, {
      write: (line) => lines.push(line),
      send: (endpoint, body) => sent.push({ endpoint, body }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pid=4242');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.endpoint).toBe(`http://127.0.0.1:5000${BEACON_PATH}`);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      pid: 4242,
      guard: 'warn',
      hooks: true,
      sandbox: 'remote:http://127.0.0.1:5000',
    });
  });

  it('skips the send when no bridge url is knowable, but still writes the line', () => {
    const lines: string[] = [];
    let sent = false;
    emitBeacon(
      { ...report, sandbox: 'local' },
      {
        write: (line) => lines.push(line),
        send: () => { sent = true; },
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bridge=none');
    expect(sent).toBe(false);
  });

  it('swallows a throwing sender — the stderr line still stands', () => {
    const lines: string[] = [];
    expect(() =>
      emitBeacon(report, {
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
 * The default sender is the part that must not keep a process alive, so it is
 * a raw `node:http` request over an unref'd socket rather than `fetch`.
 */
describe('sendBeaconRequest', () => {
  it('POSTs the body to the endpoint', async () => {
    const received: Array<{ url: string; method: string; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { raw += c; });
      req.on('end', () => {
        received.push({ url: req.url ?? '', method: req.method ?? '', body: raw });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      sendBeaconRequest(`http://127.0.0.1:${port}${BEACON_PATH}`, JSON.stringify(report));
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe('POST');
      expect(received[0]!.url).toBe(BEACON_PATH);
      expect(JSON.parse(received[0]!.body)).toMatchObject({ pid: 4242 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never throws at a refused endpoint', () => {
    // Port 1 is reliably not listening.
    expect(() => sendBeaconRequest(`http://127.0.0.1:1${BEACON_PATH}`, '{}')).not.toThrow();
  });
});
