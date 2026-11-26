import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {gzipSync, gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {nativeEvidence} from '../../reference/native.mjs';
import {encode,plausible} from '../v1/corpus.mjs';

const rows=[],seen=new Set(),quotas={};
let state=0x698a69b1;
const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*n);};
for(let i=0;i<100000;i++) {
  const color=random(2)?'w':'b',other=color==='w'?'b':'w';
  const file=random(8),destFile=file+(random(3)-1);
  if(destFile<0 || destFile>7)continue;
  const white=color==='w',from=(white?8:48)+file,to=(white?0:56)+destFile;
  const capture=file!==destFile,corner=[0,7,56,63].includes(to);
  const hold=capture && corner && random(2)===1;
  const attackedKing=hold?(white?4:60):random(64),ownKing=random(64);
  if(new Set([from,to,attackedKing,ownKing]).size!==4)continue;
  const board=Array(64).fill('');
  board[from]=color+'p';
  board[ownKing]=color+'k';
  board[attackedKing]=other+'k';
  if(capture)board[to]=other+'r';
  const castling=hold ? ({'0':'q','7':'k','56':'Q','63':'K'})[to] : '';
  const p={board,turn:color,castling,enPassant:-1};
  if(!plausible(p))continue;
  const base=arcade.squareName(from)+arcade.squareName(to);
  if(!arcade.isLegal(p,{from,to,promotion:'q'}))continue;
  const fen=encode(p),key=fen+' '+base;
  if(seen.has(key))continue;
  const variants=[...'qrbn'].map(kind=>({uci:base+kind,outcome:native.outcome(native.apply(p,base+kind))}));
  const mode=hold?'corner-held':capture&&corner?'corner-expired':capture?'capture':'quiet';
  const signature=variants.map(v=>v.outcome).join('-');
  const group=[color,mode,signature].join('/');
  if((quotas[group]??0)>=4)continue;
  quotas[group]=(quotas[group]??0)+1;seen.add(key);
  for(const {uci,outcome} of variants) {
    const status=outcome==='playing'?'playing':outcome==='checkmate'?'won':'draw';
    const wrong=status==='won'?'draw':'won';
    for(const candidate of [status,wrong]) {
      const claim={status:candidate,winner:candidate==='won'?(white?'host':'guest'):''};
      const c={id:'promotion-'+String(rows.length+1).padStart(5,'0'),fen,uci,claim};
      const a=nativeEvidence([c]).cases[0];assert.equal(a.nativeLegal,true);
      assert.equal(a.nativeAdmission,candidate===status);
      rows.push({group:color+'/'+mode+'/'+uci[4],...c,kingSafe:a.kingSafe,nativeLegal:a.nativeLegal,
        nativeAdmission:a.nativeAdmission,successor:a.successor,outcome:a.outcome,replyCount:a.replies.length,
        replySha256:sha(JSON.stringify(a.replies))});
    }
  }
}
const bytes=JSON.stringify(rows), summary={seed:'0x698a69b1',priorBoardsAndMoves:seen.size,submissions:rows.length,
  authority:'native Arcade and standalone Pyric',outcomeSignatures:quotas,sha256:sha(bytes)};
const save=(n,d)=>writeFileSync(new URL(n,import.meta.url),d,{flag:'wx'});
if(process.argv[2]==='--freeze') {
  save('corpus.json.gz',gzipSync(bytes,{level:9}));save('freeze.json',JSON.stringify(summary,null,2)+'\n');
} else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('freeze.json',import.meta.url))),summary);
  assert.equal(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
