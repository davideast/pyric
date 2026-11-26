import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.env.ORACLE_ROOT;
const entry=Bun.resolveSync('@pyric/rules',join(root,'arcade/runtime'));
const {firestoreRules}=await import(pathToFileURL(entry));
const rows=JSON.parse(readFileSync(new URL('writes.json',import.meta.url)));
function simulate(file) {
  const source=readFileSync(join(root,'trials/king-safety/artefacts',file),'utf8');
  const results=firestoreRules(source).simulate(rows).cases;
  assert.equal(results.length,rows.length);
  return Object.fromEntries(results.map((r,i)=>{
    assert.ok(!r.resourceLimit && !r.unsupported,rows[i].description);
    assert.ok(['ALLOW','DENY'].includes(r.decision), rows[i].description);
    if (r.decision === 'DENY') assert.ok(!r.trace.some(t => t.verdict === 'ERROR'), rows[i].description);
    return [rows[i].description,r.decision==='ALLOW'];
  }));
}
console.log(JSON.stringify({candidate:simulate('generated.rules'),mutant:simulate('before-board.rules')}));
