import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {legalMoves,squareName,inCheck} from '../../chess/reference/arcade-reference.ts';

export function nativeCounts() {
  let seed=0x8425ac77;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*n);};
  const rows=[],keys=new Set();
  for(const color of ['w','b'])for(let number=1;number<=10;number++) {
    const enemy=color==='w'?'b':'w';
    let count=0;
    while(count<12) {
      const cells=Array.from({length:64},(_,i)=>i);
      for(let i=cells.length-1;i>0;i--){const j=random(i+1);[cells[i],cells[j]]=[cells[j],cells[i]];}
      const board=Array(64).fill('');
      board[cells[0]]=color+'k';board[cells[1]]=enemy+'k';
      for(let i=0;i<number;i++)board[cells[i+2]]=color+'n';
      for(let i=0;i<5;i++)board[cells[number+2+i]]=enemy+'rqbnp'[i];
      const p={board,turn:color,castling:'',enPassant:-1};
      if(inCheck(p,enemy))continue;
      const encoded=board.join(',')+color;
      if(keys.has(encoded))continue;
      keys.add(encoded);
      const knightMoves=legalMoves(p).filter(m=>board[m.from]===color+'n').map(m=>squareName(m.from)+squareName(m.to)).sort();
      rows.push({color,number,board:Object.fromEntries(board.map((v,i)=>[squareName(i),v])),knightMoves});
      count++;
    }
  }
  const hash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return {rows,hash};
}

if(import.meta.main) {
  const {rows,hash}=nativeCounts();
  assert.equal(rows.length,240);
  console.log(JSON.stringify({authority:'pinned native geometry on material-bounded synthetic states',positions:rows.length,
    legalKnightMoves:rows.reduce((n,r)=>n+r.knightMoves.length,0),digest:hash},null,2));
}
