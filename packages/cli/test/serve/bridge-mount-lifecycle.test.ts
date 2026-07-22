import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';

class FakeServer extends EventEmitter {
  listening = false;

  address(): { port: number } {
    return { port: 4321 };
  }
}

describe('hosted bridge lifecycle', () => {
  it('publishes one canonical identity and removes only its own discovery pointer', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-host-'));
    const pointer = join(projectDir, '.pyric', 'serve.json');
    const server = new FakeServer();
    const mount = createBridgeMount({ project: 'demo-project', disableAuditLog: true });

    const attachment = mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
    });

    expect(server.listenerCount('upgrade')).toBe(1);
    expect(server.listenerCount('listening')).toBe(1);
    server.listening = true;
    server.emit('listening');

    const published = JSON.parse(readFileSync(pointer, 'utf8')) as {
      instanceId: string;
      project: string;
      url: string;
      mcpUrl: string;
    };
    expect(published).toMatchObject({
      instanceId: mount.instanceId,
      project: mount.project,
      url: 'http://localhost:4321',
      mcpUrl: 'http://localhost:4321/__pyric/mcp',
    });

    writeFileSync(pointer, JSON.stringify({ ...published, instanceId: 'new-owner' }));
    await attachment.close();
    await attachment.close();

    expect(existsSync(pointer)).toBe(true);
    expect(server.listenerCount('upgrade')).toBe(0);
    expect(server.listenerCount('listening')).toBe(0);
    expect(server.listenerCount('close')).toBe(0);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('closes all host attachments through an idempotent mount close', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-close-'));
    const pointer = join(projectDir, '.pyric', 'serve.json');
    const server = new FakeServer();
    server.listening = true;
    const mount = createBridgeMount({ disableAuditLog: true });

    mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
    });
    expect(existsSync(pointer)).toBe(true);

    await mount.close();
    await mount.close();

    expect(existsSync(pointer)).toBe(false);
    expect(server.listenerCount('upgrade')).toBe(0);
    expect(server.listenerCount('close')).toBe(0);
    rmSync(dirname(pointer), { recursive: true, force: true });
  });

  it('warns when the other loopback family answers with a foreign bridge', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-collision-'));
    const server = new FakeServer();
    server.listening = true;
    const warnings: string[] = [];
    const mount = createBridgeMount({ disableAuditLog: true });
    mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
      collision: {
        warn: (message) => warnings.push(message),
        fetchImpl: async () => new Response(JSON.stringify({
          mode: 'sandbox',
          instanceId: 'foreign-instance',
        }), { status: 200 }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('different loopback family');
    await mount.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('aborts and settles an in-flight collision probe before attachment close completes', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pyric-bridge-collision-close-'));
    const server = new FakeServer();
    server.listening = true;
    const warnings: string[] = [];
    let probeSignal: AbortSignal | undefined;
    let releaseProbe!: () => void;
    let probeCalls = 0;
    const mount = createBridgeMount({ disableAuditLog: true });
    const attachment = mount.attachHost({
      servers: [server as unknown as Server],
      projectDir,
      origin: () => ({ host: 'localhost', port: 4321 }),
      collision: {
        warn: (message) => warnings.push(message),
        fetchImpl: async (_input, init) => {
          probeCalls += 1;
          probeSignal = init?.signal ?? undefined;
          await new Promise<void>((resolve) => { releaseProbe = resolve; });
          return new Response(JSON.stringify({
            mode: 'sandbox',
            instanceId: 'replacement-instance',
          }), { status: 200 });
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probeCalls).toBe(1);

    const closing = attachment.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probeSignal?.aborted).toBe(true);
    releaseProbe();
    await closing;

    expect(probeCalls).toBe(1);
    expect(warnings).toHaveLength(0);
    await mount.close();
    rmSync(projectDir, { recursive: true, force: true });
  });
});
