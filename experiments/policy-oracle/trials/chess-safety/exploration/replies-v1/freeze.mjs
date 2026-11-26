import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {plausible} from '../v1/corpus.mjs';
import {bucket} from './family.mjs';
import {reverseMove} from './reverse.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

const idx=arcade.squareOf;
function random(seed) {
  let state=seed;
  return n=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return Math.floor(state/0x100000000*n);};
}
function choose(arr,rng) {return arr[rng(arr.length)];}
const rng=random(0xaf88511e);
const maxPerGroup=12;
const count={},inputs=[],seen=new Set();
const available=Array.from({length:64},(_,i)=>i);
const dist=(a,b)=>Math.max(Math.abs(a%8-b%8),Math.abs((a>>3)-(b>>3)));
for(let attempt=0;attempt<150000;attempt++) {
  const bk=choose(['a8','b8','g8','h8','a7','h7'].map(idx),rng);
  const wk=choose(available.filter(i=>dist(i,bk)>=2&&dist(i,bk)<=3),rng);
  const attacker=choose(available.filter(i=>i!==wk&&i!==bk),rng);
  const b=Array(64).fill('');b[wk]='wk';b[bk]='bk';b[attacker]=rng(4)?'wq':'wr';
  const pieces=choose(['p','n','b','r','q'],rng);
  const defender=choose(available.filter(i=>!b[i]&&(pieces!=='p'||(i>=8&&i<56))),rng);
  b[defender]='b'+pieces;
  if(attempt%3===0) {
    const extra=choose(available.filter(i=>!b[i]),rng);
    b[extra]='w'+choose(['r','b','n'],rng);
  }
  if(attempt%5===0) {
    const extra=choose(available.filter(i=>!b[i]&&i>=8&&i<56),rng);
    b[extra]='bp';
  }
  const next={board:b,turn:'b',castling:'',enPassant:-1};
  if(!plausible(next)) continue;
  const replies=native.legalMoves(next), group=bucket(next,replies);
  if(!group || (count[group]??0)>=maxPerGroup)continue;
  const row=reverseMove(next,attacker,rng);
  if(!row)continue;
  const key=row.fen+' '+row.uci;
  if(seen.has(key))continue;
  seen.add(key);
  const i=count[group]??0;count[group]=i+1;
  const result=native.outcome(next);
  const status=result==='playing'?'playing':result==='stalemate'?'draw':'won';
  const wrong=status==='won'?'draw':'won';
  for(const [control,proposed] of [['true',status],['false',wrong]]) {
    const claim={status:proposed,winner:proposed==='won'?'host':''};
    const c={...row,id:group+'-'+i+'-'+control,claim};
    const t=nativeEvidence([c]).cases[0];
    assert.equal(t.nativeLegal,true);
    assert.equal(t.nativeAdmission,control==='true');
    assert.deepEqual(t.replies,replies.sort());
    inputs.push({group,...c,kingSafe:t.kingSafe,nativeLegal:t.nativeLegal,nativeAdmission:t.nativeAdmission,
      successor:t.successor,outcome:t.outcome,replyCount:t.replies.length,replies:t.replies});
  }
}
const bytes=JSON.stringify(inputs);
const summary={seed:'0xaf88511e',authority:'native Arcade, checked against standalone Pyric',submissions:inputs.length,
  distinctLegalMoves:seen.size,groupCounts:count,sha256:sha(bytes)};
const save=(name,data)=>writeFileSync(new URL(name,import.meta.url),data,{flag:'wx'});
if(process.argv[2]==='--freeze') {
  save('corpus.json.gz',gzipSync(bytes,{level:9}));
  save('freeze.json',JSON.stringify(summary,null,2)+'\n');
} else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('freeze.json',import.meta.url))),summary);
  assert.equal(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
