import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {nativeEvidence} from '../../reference/native.mjs';
const cases=[];
const swap=s=>s===s.toLowerCase()?s.toUpperCase():s.toLowerCase();
for(const pawn of [false,true])for(const side of ['w','b']){
  let placement='8/k1K5/'+(pawn?'p5Q1':'6Q1')+'/8/8/8/8/8';
  let uci='g6c6';
  if(side==='b'){
    placement=placement.split('/').reverse().map(rank=>[...rank].map(swap).join('')).join('/');
    uci='g3c3';
  }
  const fen=placement+' '+side+' - -';
  for(const status of ['playing','won','draw']){
    const id=['sole-pawn',side,pawn?'mobile':'absent',status].join('-');
    cases.push({id,fen,uci,claim:{status,winner:status==='won'?(side==='w'?'host':'guest'):''}});
  }
}
const truth=nativeEvidence(cases);
for(const row of truth.cases){
  const pawn=row.id.includes('mobile');
  assert.equal(row.expected.status,pawn?'playing':'draw');
  assert.deepEqual(row.replies,pawn?[row.fen.includes(' w ')?'a6a5':'a3a4']:[]);
  assert.equal(row.nativeAdmission,row.submitted.status===row.expected.status);
}
for(const [name,data] of [['positions',cases],['native',truth]]) {
  const dest=new URL('controls/'+name+'.json',import.meta.url);
  if(process.argv[2]==='--freeze')writeFileSync(dest,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
  else assert.deepEqual(JSON.parse(readFileSync(dest)),data);
}
console.log(JSON.stringify({boards:4,claims:12,nativeAllows:truth.cases.filter(r=>r.nativeAdmission).length}));
