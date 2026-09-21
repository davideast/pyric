import { expect, test } from 'bun:test';

const cases = [
  ['app', 'initializeServerApp'],
  ['auth', 'linkWithPhoneNumber'],
  ['firestore', 'loadBundle'],
  ['storage', 'getStream'],
  ['ai', 'getLiveGenerativeModel'],
] as const;

for (const [service, name] of cases) {
  test(`served ${service} ${name} fails on call with its named Firebase error`, async () => {
    const fixture = new URL('../fixtures/unsupported-export.ts', import.meta.url).pathname;
    // Each public entry evaluates in its own realm, independent of other SDK tests.
    const child = Bun.spawn([process.execPath, fixture, service, name], { stdout: 'pipe', stderr: 'pipe' });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally { clearTimeout(deadline); child.kill(); }
  }, 15_000);
}
