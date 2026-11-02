import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { installRemotePeerMark } from '../../src/register/remote-peer-mark.js';
import { REMOTE_PEER_HEADER, isLocalPeer } from '../../src/serve/peer.js';

const LOOPBACK = { remoteAddress: '127.0.0.1' };

describe('isLocalPeer', () => {
  it('takes a loopback socket with no mark for local', () => {
    expect(isLocalPeer({ socket: LOOPBACK, headers: {} })).toBe(true);
    expect(isLocalPeer({ socket: LOOPBACK })).toBe(true);
  });
  it('takes a non-loopback socket for remote', () => {
    expect(isLocalPeer({ socket: { remoteAddress: '192.0.2.1' }, headers: {} })).toBe(false);
  });
  for (const value of ['1', '0', 'false', '', 'local']) {
    it(`takes a mark of "${value}" for remote: no value means local`, () => {
      expect(isLocalPeer({ socket: LOOPBACK, headers: { [REMOTE_PEER_HEADER]: value } })).toBe(false);
    });
  }
  it('ignores forwarding headers a client could send', () => {
    const headers = { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' };
    expect(isLocalPeer({ socket: { remoteAddress: '192.0.2.1' }, headers })).toBe(false);
  });
});

describe('installRemotePeerMark', () => {
  let seen: IncomingHttpHeaders = {};
  installRemotePeerMark();
  installRemotePeerMark();
  const server: Server = createServer((req, res) => {
    seen = req.headers;
    res.end('ok');
  });
  afterAll(() => server.close());

  it('leaves a loopback client unmarked, through a real server', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      get({ host: '127.0.0.1', port }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    expect(seen[REMOTE_PEER_HEADER]).toBeUndefined();
  });

  it('overwrites what a remote client sent, on requests and upgrades', () => {
    for (const event of ['request', 'upgrade']) {
      const req = { socket: { remoteAddress: '192.0.2.1' }, headers: { [REMOTE_PEER_HEADER]: '0' } };
      const probe = createServer();
      let marked: string | undefined;
      probe.on(event, (r: typeof req) => { marked = r.headers[REMOTE_PEER_HEADER]; });
      probe.emit(event, req, {}, Buffer.alloc(0));
      expect(marked).toBe('1');
    }
  });

  it('replaces every copy in the raw list, in any casing', () => {
    const rawHeaders = ['Host', 'a', 'X-Pyric-Remote-Peer', '0', 'accept', '*/*', 'x-pyric-remote-peer', 'false'];
    const req = { socket: { remoteAddress: '192.0.2.1' }, headers: {}, rawHeaders };
    createServer().emit('request', req, {});
    expect(rawHeaders).toEqual(['Host', 'a', 'accept', '*/*', REMOTE_PEER_HEADER, '1']);
  });

  it('adds the raw mark when the remote client sent none', () => {
    const rawHeaders = ['Host', 'a'];
    createServer().emit('request', { socket: { remoteAddress: '192.0.2.1' }, headers: {}, rawHeaders }, {});
    expect(rawHeaders).toEqual(['Host', 'a', REMOTE_PEER_HEADER, '1']);
  });

  it('leaves the raw list of a local client as it was', () => {
    const rawHeaders = ['Host', 'a', 'X-Pyric-Remote-Peer', '0'];
    createServer().emit('request', { socket: LOOPBACK, headers: {}, rawHeaders }, {});
    expect(rawHeaders).toEqual(['Host', 'a', 'X-Pyric-Remote-Peer', '0']);
  });

  it('marks requests on an https server', () => {
    const req: { socket: { remoteAddress: string }; headers: Record<string, string> } = { socket: { remoteAddress: '192.0.2.1' }, headers: {} };
    createHttpsServer().emit('request', req, {});
    expect(req.headers[REMOTE_PEER_HEADER]).toBe('1');
  });

  it('does not mark a local client that sent nothing', () => {
    const req: { socket: { remoteAddress: string }; headers: Record<string, string> } = { socket: LOOPBACK, headers: {} };
    const probe = createServer();
    probe.on('upgrade', () => undefined);
    probe.emit('upgrade', req, {}, Buffer.alloc(0));
    expect(req.headers[REMOTE_PEER_HEADER]).toBeUndefined();
  });
});

// A new process, because the install is once per process and other tests have already made it here.
describe('withPyric', () => {
  const script = `
    import { createServer } from 'node:http';
    import { withPyric } from ${JSON.stringify(new URL('../../src/next/with-pyric.ts', import.meta.url).pathname)};
    const marks = () => {
      const req = { socket: { remoteAddress: '192.0.2.1' }, headers: {} };
      createServer().emit('request', req, {});
      return req.headers['x-pyric-remote-peer'] !== undefined;
    };
    const before = marks();
    await withPyric({}, { guard: false })(process.env.TEST_PHASE, {});
    console.log(JSON.stringify({ before, after: marks() }));
  `;
  const run = (phase: string) => {
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, TEST_PHASE: phase } });
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as { before: boolean; after: boolean };
  };

  it('installs the mark for the dev server, also with the guard turned off', () => {
    expect(run('phase-development-server')).toEqual({ before: false, after: true });
  });

  it('leaves a production build alone', () => {
    expect(run('phase-production-build')).toEqual({ before: false, after: false });
  });
});
