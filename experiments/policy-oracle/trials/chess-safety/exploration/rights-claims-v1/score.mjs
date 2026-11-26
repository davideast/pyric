import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {sampleRights} from './fixture.mjs';
import {classify} from '../classify.mjs';

const [reference,file]=process.argv.slice(2);
assert.ok(reference && file,'usage: bun score.mjs INSTALLED_REFERENCE COMPLETE_RULES');
execFileSync('python3',[fileURLToPath(new URL('../v1/verify-simulator.py',import.meta.url)),reference]);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const code=readFileSync(file,'utf8'),handle=firestoreRules(code);
const corpus=gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString();
const manifest=JSON.parse(readFileSync(new URL('freeze.json',import.meta.url)));
assert.equal(sha(corpus),manifest.sha256);
const groups={},first={},observed=[];
for(const row of JSON.parse(corpus)) {
  const {before,proposal}=sampleRights(row,'writer','other');
  const [v]=handle.simulate([{description:row.id,method:'update',path:'chess/explore',auth:{uid:'writer'},
    resource:before,data:{...before,...proposal},expectation:'ALLOW'}]).cases;
  const {kind:status}=classify(v,row.nativeAdmission);
  const g=groups[row.group]??={cases:0,outcomes:{},peakExpressions:0};
  g.cases++;g.outcomes[status]=(g.outcomes[status]??0)+1;
  g.peakExpressions=Math.max(g.peakExpressions,v.evaluatedExpressions);
  if(status!=='match')first[status]??={...row,observed:v.decision,expressions:v.evaluatedExpressions};
  observed.push([row.id,v.decision,status,v.evaluatedExpressions]);
}
console.log(JSON.stringify({rulesSha256:sha(code),corpusSha256:manifest.sha256,moves:manifest.moves,
  writes:observed.length,scoreSha256:sha(JSON.stringify(observed)),groups,first},null,2));
