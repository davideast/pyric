// `node --import @pyric/cli/register` under PYRIC_GUARD=block must refuse the
// GCE metadata server however its address is written, a Firebase host reached
// through a proxy tunnel, and a connection from a worker thread. Before the fix
// the guard compared host text, checked only the TCP peer, and was missing from
// CommonJS eval workers and workers given their own execArgv (#1442).
//
// A child Node process of the registered process is registered too, however
// it is started: one that only inherits the environment, one given its own
// execArgv, NODE_OPTIONS or env, and one started through a shell. Before #1618
// each of those loaded the real firebase-admin.
//
// safety.mjs loads before the register and sends any connection the guard
// permits to a closed local port, so no probe reaches the network either way.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface ProbeOutput {
  results: Record<string, string>;
  escaped: string[] | null;
}

const BLOCKED = 'PYRIC_GUARD_BLOCKED';

export default scenario(async (app) => {
  const output = await app.step('run the probes under the register with PYRIC_GUARD=block', async () => {
    const closedPort = await app.freePort();
    const result = await app.command(
      'node',
      ['--import', './safety.mjs', '--import', '@pyric/cli/register', 'probes.mjs'],
      {
        env: {
          PYRIC_SANDBOX: `remote:http://127.0.0.1:${closedPort}`,
          PYRIC_GUARD: 'block',
          SCENARIO_CLOSED_PORT: String(closedPort),
        },
      },
    );
    assert.equal(result.code, 0, result.output);
    const line = result.output.split('\n').find((text) => text.startsWith('{"closedPort"'));
    assert.ok(line, `probes.mjs printed no result:\n${result.output}`);
    return JSON.parse(line) as ProbeOutput;
  });

  await app.step('the safety preload loaded before the register', () => {
    assert.ok(Array.isArray(output.escaped), 'safety.mjs did not load');
  });

  await app.step('a loopback request still works', () => {
    assert.equal(output.results['loopback control'], 'permitted');
  });

  await app.step('every respelling of the metadata IP is refused', () => {
    for (const probe of [
      'net.connect 2852039166',
      'net.connect 0xa9fea9fe',
      'net.connect 169.254.43518',
      'net.connect 0251.0376.0251.0376',
      'net.connect ::ffff:169.254.169.254',
      'net.connect ::ffff:a9fe:a9fe',
      'net.connect ::ffff:a9fe:a9fe%lo',
      'http.request 2852039166',
      'fetch http://[::ffff:169.254.169.254]/',
    ]) {
      assert.equal(output.results[probe], BLOCKED, probe);
    }
  });

  await app.step('a Firebase host reached through a proxy tunnel is refused', () => {
    assert.equal(output.results['CONNECT firestore.googleapis.com:443'], BLOCKED);
    assert.equal(output.results['tls.connect servername over a tunnel'], BLOCKED);
  });

  await app.step('worker threads are guarded too', () => {
    assert.equal(output.results['CommonJS eval worker'], BLOCKED);
    assert.equal(output.results['file worker with its own execArgv'], BLOCKED);
  });

  await app.step('every child Node process loads the swap under the parent\'s guard', () => {
    const children = Object.fromEntries(
      Object.entries(output.results).filter(([probe]) => probe.startsWith('child: ')),
    );
    assert.deepEqual(children, {
      'child: spawn(process.execPath)': 'swapped, guard block',
      'child: fork with its own execArgv': 'swapped, guard block',
      'child: spawnSync with its own NODE_OPTIONS': 'swapped, guard block',
      'child: execFile with an env of only PATH': 'swapped, guard block',
      'child: execSync through a shell': 'swapped, guard block',
    });
  });

  await app.step('no connection left loopback', () => {
    assert.deepEqual(output.escaped, []);
  });
});
