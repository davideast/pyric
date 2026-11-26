import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

// The generic registry scores the installed evaluator on fixed emitted bytes.
// The package trial separately compiles policy and links candidate output.
export async function replay(directory) {
  const root = process.env.ORACLE_ROOT;
  const entry = Bun.resolveSync('@pyric/rules', join(root,'arcade/runtime'));
  const {firestoreRules} = await import(pathToFileURL(entry));
  const writes = JSON.parse(gunzipSync(readFileSync(new URL('writes.json.gz',directory))));
  function run(name) {
    const rules = readFileSync(join(root,'trials',name),'utf8');
    const {cases} = firestoreRules(rules).simulate(writes);
    assert.equal(cases.length,writes.length);
    return Object.fromEntries(cases.map((r,i) => {
      assert.ok(['ALLOW','DENY'].includes(r.decision));
      assert.ok(!r.unsupported && !r.resourceLimit, writes[i].description);
      assert.ok(r.decision === 'ALLOW' || !r.trace.some(t=>t.verdict==='ERROR'),writes[i].description);
      return [writes[i].description,r.decision==='ALLOW'];
    }));
  }
  return {candidate:run('chess-safety/artefacts/quick-packed-v5.rules'),mutant:run('chess/bundle/artifacts/stronger.rules')};
}
