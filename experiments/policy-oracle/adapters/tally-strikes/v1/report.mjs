import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {sha} from '../../../arcade/corpus.mjs';
import {cases} from './fixture.mjs';

const [fullPath,nativeTree] = process.argv.slice(2);
assert.ok(fullPath && nativeTree,'usage: bun report.mjs FULL_SCORE.json PINNED_NATIVE_TREE');
const full = JSON.parse(readFileSync(fullPath));
const standalone = 'satisfy/tally-slate/two-strike-validation/v1';
const hosted = 'satisfy/tally-slate/compiled-two-strike-validation/v1';
const nativeFile = '../../../suites/satisfy/tally-slate/claims/two-strike-validation/v1/probes/turns/v1/evidence/native.json';
const captured = JSON.parse(readFileSync(new URL(nativeFile,import.meta.url)));
const fresh = JSON.parse(execFileSync('bun',[fileURLToPath(new URL('native.mjs',import.meta.url)),nativeTree]));
assert.equal(captured.revision,fresh.revision);
function predictions(group) {
  const rows = full.cases.filter(r=>r.claim === group);
  assert.deepEqual(rows.map(r=>r.case).sort(),cases.map(c=>c.id).sort());
  return Object.fromEntries(rows.map(r=>[r.case,r]));
}
const s = predictions(standalone), h = predictions(hosted);
const counts = {native:0,standalone:0,generatedRules:0};
const rows = cases.map(({id})=>{
  if (isDeepStrictEqual(captured.rows[id],fresh.rows[id])) counts.native++;
  if (s[id].outcome === 'match') counts.standalone++;
  if (h[id].outcome === 'match') counts.generatedRules++;
  return {id,native:fresh.rows[id],standalone:s[id].candidate,generated:h[id].candidate,live:h[id].expected};
});
const liveDigest = sha(readFileSync(new URL('generated.rules',import.meta.url)));
const generatedDigest = full.artifacts[hosted+'/turns/v1'].candidate.rulesSha256;
console.log(JSON.stringify({counts,rows,liveDigest,candidateEmittedLiveBytes:liveDigest === generatedDigest,
  candidateSha256:full.candidateSha256,evidenceSha256:full.evidenceSha256,summary:full.summary},null,2));
if (Object.values(counts).some(n=>n !== cases.length)) process.exitCode = 1;
