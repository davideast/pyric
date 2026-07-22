/**
 * WS-upgrade Origin + DNS-rebinding guard (#765). The MCP bridge peer channel
 * is registered on the WS `upgrade` event, which BYPASSES the static server's
 * request-time `isAllowedHost`. A hostile page could open a WS to the loopback
 * bridge and hijack the agent tool channel (`registerSandboxPeer` last-wins).
 *
 * These tests drive `mount.attachHost`'s upgrade handler DIRECTLY with a fake
 * EventEmitter "server" + mock req/socket — no real listen()/socket, per the
 * repo's CI-hang constraint (real-server+loopback tests hang under bun/Linux).
 * `WebSocketServer.prototype.handleUpgrade` is stubbed so we can assert whether
 * the guard let the upgrade THROUGH (handshake reached) or rejected it
 * (`socket.destroy()` before any peer registration).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';

const WS_PATH = '/__pyric/sandbox';

// Stub the real handshake so no socket work happens; record each pass-through.
const realHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
let handshakes: number;
beforeEach(() => {
  handshakes = 0;
  WebSocketServer.prototype.handleUpgrade = mock(() => {
    handshakes += 1;
    // Do NOT invoke the callback — attachPeer would try to use a fake ws.
  }) as unknown as typeof realHandleUpgrade;
});
afterEach(() => {
  WebSocketServer.prototype.handleUpgrade = realHandleUpgrade;
});

interface UpgradeResult {
  destroyed: boolean;
  handshakes: number;
}

/** Build a guarded mount, emit one `upgrade`, report what happened. */
function driveUpgrade(
  headers: Record<string, string | undefined>,
  opts: { path?: string; allowedHosts?: string[] | true; boundHost?: string } = {},
): UpgradeResult {
  const mount = createBridgeMount({
    disableAuditLog: true,
    upgradeGuard: { boundHost: opts.boundHost ?? 'localhost', allowedHosts: opts.allowedHosts },
  });
  const server = new EventEmitter();
  mount.attachHost({
    servers: [server as unknown as Server],
    projectDir: process.cwd(),
    origin: () => null,
  });

  let destroyed = false;
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => { destroyed = true; socket.emit('close'); };
  const req = { url: opts.path ?? WS_PATH, headers };
  server.emit('upgrade', req, socket, Buffer.alloc(0));
  return { destroyed, handshakes };
}

describe('bridge WS upgrade guard (#765)', () => {
  it('rejects a cross-origin Origin before peer registration', () => {
    const r = driveUpgrade({ host: 'localhost:5000', origin: 'http://attacker.com' });
    expect(r.destroyed).toBe(true);
    expect(r.handshakes).toBe(0); // never reached handleUpgrade → no peer registered
  });

  it('rejects a rebinding Host (DNS-rebinding) before peer registration', () => {
    const r = driveUpgrade({ host: 'attacker.com:5000', origin: 'http://attacker.com:5000' });
    expect(r.destroyed).toBe(true);
    expect(r.handshakes).toBe(0);
  });

  it('accepts a loopback Host + loopback Origin (legit in-page peer)', () => {
    const r = driveUpgrade({ host: 'localhost:5000', origin: 'http://localhost:5000' });
    expect(r.destroyed).toBe(false);
    expect(r.handshakes).toBe(1); // guard passed → handshake proceeds
  });

  it('accepts a non-browser peer (no Origin) on a loopback Host', () => {
    const r = driveUpgrade({ host: '127.0.0.1:5000' });
    expect(r.destroyed).toBe(false);
    expect(r.handshakes).toBe(1);
  });

  it('honors --allowed-host for both Host and Origin', () => {
    const r = driveUpgrade(
      { host: 'app.test:5000', origin: 'http://app.test:5000' },
      { allowedHosts: ['app.test'] },
    );
    expect(r.destroyed).toBe(false);
    expect(r.handshakes).toBe(1);
  });

  it('allowedHosts:true (vite opt-in to all hosts) skips the guard', () => {
    const r = driveUpgrade(
      { host: 'anything.example', origin: 'http://anything.example' },
      { allowedHosts: true },
    );
    expect(r.destroyed).toBe(false);
    expect(r.handshakes).toBe(1);
  });

  it('ignores upgrades on other paths (not our WS route)', () => {
    const r = driveUpgrade({ host: 'localhost:5000' }, { path: '/some/other/ws' });
    // Not our path: handler returns early, neither destroys nor handshakes.
    expect(r.destroyed).toBe(false);
    expect(r.handshakes).toBe(0);
  });
});
