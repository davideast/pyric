// Run only in the independent, pinned reference runtime. The package under test
// has finished executing before this process receives its emitted module as data.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFixture, materialize } from '../../../adapters/arcade-sdk/v1/fixture.mjs';

const root = process.env.ORACLE_ROOT;
const arcade = join(root, 'arcade');
const runtime = join(arcade, 'runtime');
const pkg = join(runtime, 'node_modules/@pyric/rules');
const { firestoreRules, timestamp, serverTimestamp } = await import(pathToFileURL(join(pkg, 'dist/index.js')));
const stock = join(arcade, 'v1/rules/stock.rules');
const full = '/tmp/bundle/full.rules';

async function run(script, args) {
  const worker = new Worker(new URL(script, import.meta.url), { argv: args, stdout: true, stderr: true });
  let stdout = '', stderr = '';
  worker.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  worker.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [status] = await once(worker, 'exit');
  if (status !== 0) throw Error(stderr.slice(-1800) || 'referee exited ' + status);
  return stdout;
}

const fixture = loadFixture(pathToFileURL(join(root,
  'suites/arcade/sokoban/claims/push-tiebreak/v1/probes/equal-moves/v1/')));
function publicDecisions(file) {
  const rules = firestoreRules(readFileSync(file, 'utf8'));
  return Object.fromEntries(fixture.cases.map(({ id }) => {
    try {
      const { actor, path, before, data, operation, requestTime } = materialize(fixture, id, {
        actor: 'oracle-writer', reader: 'oracle-reader', runId: 'offline',
      });
      assert.equal(operation, 'set');
      assert.equal(data.createdAt, '$serverTimestamp');
      const rows = rules.simulate([{ description: id, method: 'update', path, auth: { uid: actor },
        resource: { ...before, createdAt: timestamp(before.createdAt) },
        data: { ...data, createdAt: serverTimestamp() }, writeMode: { kind: 'set', merge: false },
        requestTime, expectation: 'ALLOW' }]).cases;
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.description, id);
      assert.ok(!row.unsupported && !row.resourceLimit && ['ALLOW', 'DENY'].includes(row.decision));
      return [id, { decision: row.decision }];
    } catch (error) {
      return [id, { error: String(error) }];
    }
  }));
}

const emitted = Buffer.from(process.argv.slice(2).join(''), 'base64');
writeFileSync('/tmp/emitted.rules', emitted);
await run('generate.mjs', [pkg, arcade, '/tmp/bundle', '/tmp/emitted.rules']);
const expectedStock = publicDecisions(stock);
const generated = publicDecisions(full);
let heldOut;
try {
  const result = JSON.parse(await run('sealed/score.mjs', [runtime, stock, full]));
  assert.equal(result.revisions.length, 1);
  heldOut = { stock: result.stock, generated: result.revisions[0] };
} catch (error) {
  heldOut = { error: String(error) };
}
console.log(JSON.stringify({ bundle: readFileSync(full, 'base64'), publicStock: expectedStock, generated, heldOut }));
