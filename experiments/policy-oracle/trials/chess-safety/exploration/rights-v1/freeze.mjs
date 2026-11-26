import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import * as arcade from '../../../chess/reference/arcade-reference.ts';
import {encode,plausible} from '../v1/corpus.mjs';
import {nativeEvidence} from '../../reference/native.mjs';

const ids=new Set(),rows=[];
const sides=['w','b'], corners=[63,56,7,0];
const name=arcade.squareName;
function store(group,p,from,to) {
  const m={from,to};
  const piece=p.board[from];
  if(!piece || p.board[to][0]===p.turn || !plausible(p) || !arcade.isLegal(p,m)) return;
  const uci=name(from)+name(to),fen=encode(p),key=fen+' '+uci;
  if(ids.has(key))return;
  ids.add(key);
  const id='rights-'+String(rows.length+1).padStart(5,'0');
  const c={group,id,fen,uci};
  const [a]=nativeEvidence([c]).cases;
  assert.equal(a.nativeLegal,true);
  rows.push({...c,nativeLegal:true,kingSafe:a.kingSafe,nativeAdmission:true,
    successor:a.successor,outcome:a.outcome,replyCount:a.replies.length,replySha256:sha(JSON.stringify(a.replies))});
}
for(let mask=1;mask<16;mask++) for(const color of sides) {
  const rights=[...'KQkq'].filter((_,i)=>mask&(1<<i)).join('');
  const base=Array(64).fill('');base[60]='wk';base[4]='bk';
  for(const [i,r] of [...'KQkq'].entries()) if(rights.includes(r)) base[corners[i]]=(i>=2?'b':'w')+'r';
  for(const [ci,corner] of corners.entries()) {
    if(!rights.includes('KQkq'[ci]))continue;
    const enemy=base[corner][0]!==color;
    for(let i=0;i<64;i++) {
      if(i===corner || base[i]) continue;
      const xDiff=Math.abs(i%8-corner%8),yDiff=Math.abs((i>>3)-(corner>>3));
      const diagonal=xDiff===yDiff,straight=xDiff===0||yDiff===0;
      if(!diagonal&&!straight) continue;
      if(!enemy&&!straight) continue;
      for(const attacker of enemy?(diagonal?['b','q']:['r','q']):['r']) {
        // Dense control pairs change occupancy away from the three changing
        // squares. Geometric right-to-castle and source side are preserved.
        for(const density of [0,1]) {
          const board=[...base];
          if(enemy)board[i]=color+attacker;
          if(density) for(const [sq,piece] of [[10,'bp'],[14,'bn'],[27,'bp'],[48,'wp'],[58,'wb'],[45,'wn'],[51,'wp']])
            if(!board[sq]&&sq!==i)board[sq]=piece;
          const from=enemy?i:corner,to=enemy?corner:i;
          store((enemy?'capture-':'departure-')+(diagonal?'diagonal':'straight')+'-'+(density?'dense':'sparse'),
            {board,turn:color,castling:rights,enPassant:-1},from,to);
        }
      }
    }
  }
}
const bytes=JSON.stringify(rows),counts={};
for(const {group} of rows) counts[group]=(counts[group]??0)+1;
const summary={description:'native-legal corner moves exercising castling rights expiry',cases:rows.length,
  groups:counts,sha256:sha(bytes)};
const save=(n,d)=>writeFileSync(new URL(n,import.meta.url),d,{flag:'wx'});
if(process.argv[2]==='--freeze') {
  save('corpus.json.gz',gzipSync(bytes,{level:9}));
  save('freeze.json',JSON.stringify(summary,null,2)+'\n');
} else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('freeze.json',import.meta.url))),summary);
  assert.equal(gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url))).toString(),bytes);
}
console.log(JSON.stringify(summary,null,2));
