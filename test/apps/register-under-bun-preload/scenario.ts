// #1624: Under `bun --preload @pyric/cli/register` (or `preload` in
// `bunfig.toml`), `@pyric/cli/register` must refuse to activate with
// `PYRIC_UNSUPPORTED_RUNTIME` naming Bun rather than claiming active hooks or
// blaming a Node version, and the probe must never load the real SDK.
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:http';
import { scenario } from '../driver.ts';

interface ProbeReport {
  readonly pid: number;
  readonly kind: string;
  readonly marked: boolean;
}

function parseProbe(output: string): ProbeReport {
  const line = output.split('\n').find((entry) => entry.startsWith('PROBE '));
  assert.ok(line !== undefined, `expected a PROBE line:\n${output}`);
  return JSON.parse(line.slice('PROBE '.length)) as ProbeReport;
}

export default scenario(async (app) => {
  const receivedBeacons: string[] = [];
  const beaconServer = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      receivedBeacons.push(`${req.method ?? ''} ${req.url ?? ''} ${body}`);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolveListen) => {
    beaconServer.listen(0, '127.0.0.1', resolveListen);
  });
  const beaconPort = (beaconServer.address() as AddressInfo).port;

  try {
    await app.step('bun --preload @pyric/cli/register refuses with PYRIC_UNSUPPORTED_RUNTIME naming Bun and sends no beacon', async () => {
      const result = await app.command(
        process.execPath,
        ['--preload', '@pyric/cli/register', 'probe.mjs'],
        {
          env: {
            PYRIC_SANDBOX: `remote:http://127.0.0.1:${beaconPort}`,
            PYRIC_BEACON_TOKEN: 'bun-preload-token',
            PYRIC_DEBUG: '1',
          },
        },
      );
      assert.notEqual(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /@pyric\/cli\/register: active/, result.output);
      assert.doesNotMatch(result.output, /beacon ACTIVE/, result.output);
      assert.doesNotMatch(result.output, /hooks=1/, result.output);
      assert.doesNotMatch(result.output, /^PROBE /m, result.output);
      assert.doesNotMatch(result.output, /PYRIC_UNSUPPORTED_NODE_VERSION/, result.output);
      assert.match(result.output, /Bun /i, result.output);
      assert.match(result.output, /PYRIC_UNSUPPORTED_RUNTIME/, result.output);
      assert.deepEqual(receivedBeacons, []);
    });

    await app.step('preload in bunfig.toml refuses with PYRIC_UNSUPPORTED_RUNTIME before running the probe', async () => {
      app.writeFile('bunfig.toml', 'preload = ["@pyric/cli/register"]\n');
      const result = await app.command(
        process.execPath,
        ['probe.mjs'],
        { env: { PYRIC_SANDBOX: 'local', PYRIC_DEBUG: '1' } },
      );
      assert.notEqual(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /@pyric\/cli\/register: active/, result.output);
      assert.doesNotMatch(result.output, /^PROBE /m, result.output);
      assert.match(result.output, /Bun /i, result.output);
      assert.match(result.output, /PYRIC_UNSUPPORTED_RUNTIME/, result.output);
    });

    await app.step('node --import @pyric/cli/register swaps firebase-admin and sets the activation mark', async () => {
      const result = await app.command(
        'node',
        ['--import', '@pyric/cli/register', 'probe.mjs'],
        { env: { PYRIC_SANDBOX: 'local' } },
      );
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /@pyric\/cli\/register: active/, result.output);
      assert.deepEqual(parseProbe(result.output), {
        pid: parseProbe(result.output).pid,
        kind: 'swapped',
        marked: true,
      });
    });
  } finally {
    await new Promise<void>((resolveClose) => {
      beaconServer.close(() => resolveClose());
    });
  }
});
