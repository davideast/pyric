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
}

const FIXTURE = resolve(import.meta.dir, 'fixtures/node-origin-client.ts');
const SERVICES = ['database', 'firestore', 'auth', 'storage'];

function run(mode: 'off-host' | 'unreachable'): Map<string, Line> {
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
