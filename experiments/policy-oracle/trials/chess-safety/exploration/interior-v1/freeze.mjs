import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {plausible} from '../v1/corpus.mjs';
import {reverseMove} from '../replies-v1/reverse.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

let state=0x5f5084a2;
function random(n){state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*n);}
const pick=a=>a[random(a.length)];
const all=Array.from({length:64},(_,i)=>i),rows=[],counts={},seen=new Set();
for(let attempt=0;attempt<250000;attempt++) {
  const defend=random(2)?'w':'b',attack=defend==='w'?'b':'w';
  const squares=all.filter(i=>i%8>=1&&i%8<=6&&(i>>3)>=1&&(i>>3)<=6);
  const king=pick(squares),board=Array(64).fill('');board[king]=defend+'k';
  const free=()=>pick(all.filter(i=>!board[i]));
  board[free()]=attack+'k';
  const attackers=[];
  for(let n=2+random(3);n>0;n--) {
    const i=free();board[i]=attack+pick(['q','q','r','r','b','n']);attackers.push(i);
  }
  for(let n=random(3);n>0;n--) {
    const i=free();board[i]=defend+pick(i>=8&&i<56?['p','p','r','n','b']:['r','n','b']);
  }
  const next={board,turn:defend,castling:'',enPassant:-1};
  if(!plausible(next))continue;
  const replies=native.legalMoves(next);
  if(replies.length>1)continue;
  const check=arcade.inCheck(next);
  let family;
  if(!replies.length) family=check?'mate':'stalemate';
  else family=(board[arcade.squareOf(replies[0].slice(0,2))][1]==='k'?'king':'nonking')+(check?'-checked':'-unchecked');
  const group=defend+'/'+family;
  if((counts[group]??0)>=16)continue;
  // Undo the last move of one attacker to find a legal pre-check source.
  let prior;
  for(const attacker of attackers) {
    prior=reverseMove(next,attacker,random);
    if(prior)break;
  }
  if(!prior)continue;
  const key=prior.fen+' '+prior.uci;
  if(seen.has(key))continue;
  seen.add(key);counts[group]=(counts[group]??0)+1;
  const result=native.outcome(next),status=result==='playing'?'playing':result==='stalemate'?'draw':'won';
  for(const proposed of [status,status==='won'?'draw':'won']) {
    const id='interior-'+String(rows.length+1).padStart(3,'0');
    const c={id,...prior,claim:{status:proposed,winner:proposed==='won'?(attack==='w'?'host':'guest'):''}};
    const a=nativeEvidence([c]).cases[0];
    assert.equal(a.nativeLegal,true);assert.equal(a.nativeAdmission,proposed===status);
    assert.deepEqual(a.replies,replies.sort());
    rows.push({group,...c,kingSafe:a.kingSafe,nativeLegal:true,nativeAdmission:a.nativeAdmission,successor:a.successor,
      outcome:a.outcome,replyCount:a.replies.length,replySha256:sha(JSON.stringify(a.replies))});
  }
  if(Object.keys(counts).length===12 && Object.values(counts).every(k=>k===16)) break;
}
const bytes=JSON.stringify(rows),summary={seed:'0x5f5084a2',pairs:seen.size,writes:rows.length,counts,sha256:sha(bytes)};
const save=(name,data)=>writeFileSync(new URL(name,import.meta.url),data,{flag:'wx'});
if(process.argv[2]==='--freeze'){
  save('corpus.json.gz',gzipSync(bytes,{level:9}));save('freeze.json',JSON.stringify(summary,null,2)+'\n');
}else{
  assert.deepEqual(JSON.parse(readFileSync(new URL('freeze.json',import.meta.url))),summary);
  assert.equal(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
