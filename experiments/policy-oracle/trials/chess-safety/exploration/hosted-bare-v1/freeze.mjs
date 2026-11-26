import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {nativeEvidence} from '../../reference/native.mjs';
const rows=JSON.parse(gunzipSync(readFileSync(new URL('../bare-defender-v1/corpus.json.gz',import.meta.url))));
const wanted=[['sparse-king-move','w/quiet/2/k/stalemate'],['dense-knight-mate','b/quiet/15/n/checkmate'],
  ['crowded-quiet-stalemate','w/quiet/12/q/stalemate'],['capture-last-defender','b/capture-last-defender/r'],
  ['knight-underpromotion','w/promote/n'],['black-castle','bare-1966'],['nonbare-knight-evasion','w/nonbare/checkmate/one-n-reply']];
const positions=[];
for(const [name,source] of wanted){
  const row=rows.find(c=>c.group===source||c.id===source);
  assert.ok(row,source);
  for(const status of ['playing','draw','won']){
    const white=row.fen.split(' ')[1]==='w';
    positions.push({id:'bare-holdout-'+name+'-'+status,fen:row.fen,uci:row.uci,claim:{status,winner:status==='won'?(white?'host':'guest'):''}});
  }
}
const truth=nativeEvidence(positions);
for(let i=0;i<positions.length;i+=3){
  const group=truth.cases.slice(i,i+3);
  assert.ok(group.every(c=>c.nativeLegal));
  assert.equal(group.filter(c=>c.nativeAdmission).length,1);
  assert.equal(new Set(group.map(c=>c.successor)).size,1);
}
for(const [name,data] of [['positions',positions],['native',truth]]){
  const file=new URL('controls/'+name+'.json',import.meta.url);
  if(process.argv[2]==='--freeze')writeFileSync(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
  else assert.deepEqual(JSON.parse(readFileSync(file)),data);
}
console.log(JSON.stringify({authorities:'previously frozen native Arcade, standalone Pyric and private python-chess audit',moves:wanted.length,writes:positions.length}));
