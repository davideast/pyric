import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

// Each existing pair contains two claims. Submit the two missing claims
// against the identical move to complete four alternatives without overlap.
const rows=[],seen=new Set(),sources={};
for(const suite of ['replies-v1','interior-v1']) {
  const read=name=>readFileSync(new URL('../'+suite+'/'+name,import.meta.url));
  const bytes=gunzipSync(read('corpus.json.gz'));
  sources[suite]=sha(bytes);
  assert.equal(sources[suite],JSON.parse(read('freeze.json')).sha256);
  const boards=new Map();
  for(const row of JSON.parse(bytes)) {
    const key=row.fen+' '+row.uci;
    const family=boards.get(key)??[];
    family.push(row);
    boards.set(key,family);
  }
  for(const [key,pair] of boards) {
    assert.ok(!seen.has(key));seen.add(key);
    assert.equal(pair.length,2);
    const {fen,uci,group}=pair[0],writer=fen.split(' ')[1]==='w'?'host':'guest';
    const correct=pair.find(c=>c.nativeAdmission);
    assert.ok(correct);
    const variants=[{status:'playing',winner:''},{status:'draw',winner:''},{status:'won',winner:writer},
      {status:'won',winner:writer==='host'?'guest':'host'}];
    const untouched=variants.filter(c=>!pair.some(p=>c.status===p.claim.status&&c.winner===p.claim.winner));
    assert.equal(untouched.length,2);
    for(const claim of untouched) {
      const id='remaining-claim-'+String(rows.length+1).padStart(3,'0'),c={id,fen,uci,claim};
      const truth=nativeEvidence([c]).cases[0];
      assert.ok(truth.nativeLegal);
      assert.equal(truth.nativeAdmission,false);
      assert.equal(truth.successor,correct.successor);
      rows.push({...c,group:suite+'/'+group,kingSafe:truth.kingSafe,nativeLegal:truth.nativeLegal,
        nativeAdmission:truth.nativeAdmission,successor:truth.successor,outcome:truth.outcome,
        replyCount:truth.replies.length,replySha256:sha(JSON.stringify(truth.replies))});
    }
  }
}
const bytes=JSON.stringify(rows),summary={sources,moves:seen.size,writes:rows.length,sha256:sha(bytes)};
const url=n=>new URL(n,import.meta.url);
if(process.argv[2]==='--freeze'){
  writeFileSync(url('corpus.json.gz'),gzipSync(bytes,{level:9}),{flag:'wx'});
  writeFileSync(url('freeze.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}else{
  assert.deepEqual(JSON.parse(readFileSync(url('freeze.json'))),summary);
  assert.equal(gunzipSync(readFileSync(url('corpus.json.gz'))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
