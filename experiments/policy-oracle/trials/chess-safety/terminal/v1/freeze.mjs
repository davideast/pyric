import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {outcome} from '../../../chess/reference/native.mjs';
import {inCheck} from '../../../chess/reference/arcade-reference.ts';
const cells=Array(64).fill('');
let tested=0;
const tally={playing:0,checkmate:0,stalemate:0}, hash=createHash('sha256');
for(const color of ['w','b'])for(const piece of ['r','q']){
  const defender=color==='w'?'b':'w';
  const pos={board:cells,turn:defender,castling:'',enPassant:-1};
  for(let s=0;s<64;s++)for(let d=0;d<64;d++){
    if(s===d)continue;
    cells[s]=color+piece;cells[d]=defender+'k';
    for(let a=0;a<64;a++){
      if(a===s||a===d)continue;
      cells[a]=color+'k';
      if(!inCheck(pos,color)){
        const decision=outcome(pos);
        tally[decision]++;tested++;
        hash.update([color,piece,s,d,a,decision].join(' ')+'\n');
      }
      cells[a]='';
    }
    cells[d]='';cells[s]='';
  }
}
assert.equal(Object.values(tally).reduce((a,b)=>a+b,0),tested);
console.log(JSON.stringify({nativeCases:tested,tally,digest:hash.digest('hex')},null,2));
