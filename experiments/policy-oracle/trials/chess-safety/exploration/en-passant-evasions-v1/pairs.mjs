import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {nativeEvidence} from '../../reference/native.mjs';
const rows = JSON.parse(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))));
const inputs = new Map();
for(const c of rows.filter(r=>r.group.includes('two-capturers'))) inputs.set(c.fen,c);
const pairs=[];
for(const c of inputs.values()) {
  const file='abcdefgh'.indexOf(c.uci[2]);
  const moves=[file-1,file+1].map((f,i)=>({id:'ep-pair-'+pairs.length+'-'+i,fen:c.fen,uci:'abcdefgh'[f]+c.uci[1]+c.uci.slice(2)}));
  const {cases}=nativeEvidence(moves);
  assert.deepEqual(cases.map(x=>x.nativeAdmission).sort(),[false,true]);
  pairs.push({priorFen:c.priorFen,push:c.push,fen:c.fen,cases:cases.map(({id,uci,nativeAdmission,successor})=>({id,uci,nativeAdmission,successor}))});
}
const file=new URL('pairs.json',import.meta.url);
if(process.argv[2]==='--freeze')writeFileSync(file,JSON.stringify(pairs,null,2)+'\n',{flag:'wx'});
else assert.deepEqual(JSON.parse(readFileSync(file)),pairs);
console.log(JSON.stringify({pairedBoards:pairs.length,proposals:pairs.length*2}));
