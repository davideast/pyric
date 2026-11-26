// Count exact identical chess updates separately from distinct continuations
// and from different metadata claims on the same move. Paths and case IDs are
// normalized, as they identify the experiment and are not chess inputs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sample} from '../../reference/fixtures.mjs';
import {sampleRights} from '../rights-claims-v1/fixture.mjs';

const trial=resolve(process.argv[2] || fileURLToPath(new URL('../../',import.meta.url)));
const read=(...parts)=>JSON.parse(readFileSync(join(trial,...parts)));
const cohorts=new Map();
for(const name of ['native','cost-native','path-native']){
  const {cases}=read('../king-safety/reference',name+'.json');
  cohorts.set('file-pins/'+name,cases);
}
for(const name of readdirSync(join(trial,'batches')).sort())
  cohorts.set(name,read('batches',name,'v1/native.json').cases);
for(const name of ['v1','replies-v1','rights-v1','promotions-v1','interior-v1','rights-claims-v1',
                   'self-check-v1','king-last-v1','successor-claims-v1','bare-defender-v1']){
  const rows=gunzipSync(readFileSync(join(trial,'exploration',name,'corpus.json.gz')));
  const meta=read('exploration',name,'freeze.json');
  assert.equal(createHash('sha256').update(rows).digest('hex'),meta.sha256??meta.inputsSha256);
  cohorts.set(name,JSON.parse(rows));
}
const exact=new Map(),cases={},positions=new Set(),moves=new Set(),examples=[];
let total=0;
for(const [name,rows] of cohorts) {
  let repeats=0;
  for(const c of rows) {
    const project=Object.hasOwn(c,'claimedRights')?sampleRights:sample;
    const {before,proposal}=project(c,'writer','other');
    const digest=createHash('sha256').update(JSON.stringify([before,{...before,...proposal}])).digest('hex');
    const allowed=c.nativeAdmission??c.nativeLegal, previous=exact.get(digest);
    positions.add(c.fen);moves.add(c.fen+' '+c.uci);total++;
    assert.equal(typeof allowed,'boolean',c.id);
    if(previous){
      assert.equal(allowed,previous.allowed,c.id+' changed truth for identical proposal '+previous.id);
      repeats++;
      if(examples.length<5)examples.push({first:previous.id,repeat:c.id,firstCohort:previous.name,repeatCohort:name});
    } else exact.set(digest,{id:c.id,name,allowed});
  }
  cases[name]={submitted:rows.length,newSignedPayloads:rows.length-repeats,repeats};
}
console.log(JSON.stringify({submissions:total,distinctFens:positions.size,distinctFenMoves:moves.size,
  uniqueSignedPayloads:exact.size,repeats:total-exact.size,conflictingNativeAnswers:0,
  digestFields:'complete canonical projected resource and merged successor under fixed actors and path',cases,examples},null,2));
