/**
 * The served client surfaces in a Node process (#1082) never fall back to the
 * page's in-page sandbox: with a Node runtime origin they always choose the
 * hosted transport, and when the host is not the Node host, or cannot be
 * found, every call fails instead. The served `firebase/app` entry's
 * placeholder sandbox stays empty, and the app registry is bound to the
 * refusal, so a `pyric/*` mirror resolved from the app refuses too.
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

interface Line {
  name: string;
  ok?: boolean;
  code?: string | null;
  message?: string;
  useWorker?: boolean;
  useHosted?: boolean;
  placeholderValue?: unknown;
  type?: string;
  hostInstanceId?: string | null;
}

const FIXTURE = resolve(import.meta.dir, 'fixtures/node-origin-client.ts');
const SERVICES = ['database', 'firestore', 'auth', 'storage'];

function run(mode: 'off-host' | 'unreachable' | 'late-host' | 'attach'): Map<string, Line> {
  const result = Bun.spawnSync([process.execPath, FIXTURE, mode], { env: { ...process.env, PYRIC_SANDBOX: '' } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const lines = result.stdout.toString().trim().split('\n').filter(line => line.startsWith('{'));
  return new Map(lines.map(line => JSON.parse(line) as Line).map(line => [line.name, line]));
}

function expectNoFallback(lines: Map<string, Line>): void {
  expect(lines.get('state')).toEqual({ name: 'state', useWorker: true, useHosted: true, placeholderValue: null });
  const mirror = lines.get('mirror');
  expect(mirror?.code).toBe('failed-precondition');
  expect(mirror?.message).toContain('does not reach the sandbox host from a server process');
}

describe('served client surfaces under a Node runtime origin', () => {
  it('refuse every call with failed-precondition when the host is not the Node host', () => {
    const lines = run('off-host');
    for (const service of SERVICES) {
      const line = lines.get(service);
      expect(line?.ok, service).toBe(false);
      expect(line?.code, service).toBe('failed-precondition');
      expect(line?.message, service).toContain('reach only the Node host');
    }
    expectNoFallback(lines);
  });

  it('choose again at the next call after the host could not be found, keeping no failure', () => {
    const lines = run('late-host');
    for (const service of SERVICES) {
      const first = lines.get(service);
      expect(first?.ok, service).toBe(false);
      expect(first?.message, service).toContain('no running `pyric sandbox --bridge` found');
      // The host now answers: the same app reads its init.json, which names it off-host.
      const again = lines.get(`${service}.again`);
      expect(again?.ok, `${service}.again`).toBe(false);
      expect(again?.code, `${service}.again`).toBe('failed-precondition');
      expect(again?.message, `${service}.again`).toContain('reach only the Node host');
    }
    expectNoFallback(lines);
  });

  it("present the host boot named in the Node host's init.json on attach", () => {
    const lines = run('attach');
    expect(lines.get('attach')).toEqual({ name: 'attach', type: 'attach', hostInstanceId: 'host-boot-1' });
  });

  it('fail every call with the discovery error when no host is found', () => {
    const lines = run('unreachable');
    for (const service of SERVICES) {
      const line = lines.get(service);
      expect(line?.ok, service).toBe(false);
      expect(line?.message, service).toContain('no running `pyric sandbox --bridge` found');
    }
    expectNoFallback(lines);
  });
});

describe('the host boot a Node process reads before it reattaches', () => {
  it('is read from init.json afresh each time, and that read answers the next session-token read', () => {
    const fixture = resolve(import.meta.dir, 'fixtures/node-boot-reads.ts');
    const result = Bun.spawnSync([process.execPath, fixture], { env: { ...process.env, PYRIC_SANDBOX: '' } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const line = result.stdout.toString().trim().split('\n').find(text => text.startsWith('{'));
    expect(JSON.parse(line ?? '{}')).toEqual({ first: 'boot-1', second: 'boot-2', token: 'token-2', requests: 2 });
  });
});
