import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {outcome} from '../../../chess/reference/native.mjs';
import {inCheck} from '../../../chess/reference/arcade-reference.ts';
const cells=Array(64).fill('');
const hash=createHash('sha256'),tally={};
for(const color of ['w','b'])for(const piece of ['r','q','b','n']){
  const defender=color==='w'?'b':'w';
  const pos={board:cells,turn:defender,castling:'',enPassant:-1};
  const counts=tally[color+piece]={playing:0,checkmate:0,stalemate:0};
  for(let s=0;s<64;s++)for(let d=0;d<64;d++){
    if(s===d)continue;
    cells[s]=color+piece;cells[d]=defender+'k';
    for(let a=0;a<64;a++){
      if(a===s||a===d)continue;
      cells[a]=color+'k';
      if(!inCheck(pos,color)){
        const result=outcome(pos);
        counts[result]++;
        hash.update([color,piece,s,d,a,result].join(' ')+'\n');
      }
      cells[a]='';
    }
    cells[s]='';cells[d]='';
  }
  assert.equal(Object.values(counts).reduce((a,b)=>a+b),223944);
}
console.log(JSON.stringify({authority:'pinned Arcade native',tally,positions:1791552,sha256:hash.digest('hex')},null,2));
