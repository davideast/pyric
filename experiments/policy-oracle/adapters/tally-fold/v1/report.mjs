import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {sha} from '../../../arcade/corpus.mjs';
import {cases} from './fixture.mjs';

const [scoreFile,nativeTree] = process.argv.slice(2);
assert.ok(scoreFile && nativeTree,'usage: bun report.mjs FULL_SCORE.json PINNED_SATISFY_TREE');
const claim = 'satisfy/tally-slate/';
const base = '../../../suites/satisfy/tally-slate/claims/';
const read = path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
const stock = read(base+'two-action-fold/v1/probes/turns/v1/evidence/native.json');
const native = spawnSync('bun',[fileURLToPath(new URL('native.mjs',import.meta.url)),resolve(nativeTree)],{encoding:'utf8'});
assert.equal(native.status,0,native.stderr);
const observed = JSON.parse(native.stdout);
assert.equal(observed.revision,stock.revision);
const full = JSON.parse(readFileSync(scoreFile));
function rows(group) {
  const result = full.cases.filter(r=>r.claim === claim+group+'/v1');
  assert.deepEqual(result.map(r=>r.case).sort(),cases.map(c=>c.id).sort());
  return Object.fromEntries(result.map(r=>[r.case,r]));
}
const standalone = rows('two-action-fold'), hosted = rows('compiled-two-action-fold');
const liveDigest = sha(readFileSync(new URL('generated.rules',import.meta.url)));
const packageDigest = full.artifacts[claim+'compiled-two-action-fold/v1/turns/v1'].candidate.rulesSha256;
const counts = {native:0,standalone:0,generatedRules:0};
const results = cases.map(c=>{
  const ref = observed.rows[c.id], s = standalone[c.id], h = hosted[c.id];
  if (isDeepStrictEqual(ref,stock.rows[c.id])) counts.native++;
  if (s.outcome === 'match') counts.standalone++;
  if (h.outcome === 'match') counts.generatedRules++;
  return {case:c.id,nativeTotal:ref.model,nativeTurnAccepted:ref.turnParser.accepted,
    nativeClaimMatches:ref.claimMatchesNative,standalone:s.candidate,
    generatedRulesReplay:h.candidate,liveFirestore:h.expected};
});
console.log(JSON.stringify({counts,casesPerScore:cases.length,results,liveDigest,candidateEmittedLiveBytes:packageDigest === liveDigest},null,2));
if (Object.values(counts).some(n=>n !== cases.length)) process.exitCode = 1;
