import {position} from '../../chess/reference/score.mjs';
import {legalMoves,squareName,attacked,squareOf} from '../../chess/reference/arcade-reference.ts';
import assert from 'node:assert/strict';
// Two simultaneously pinned knights bracket a third, promoted knight in
// each source ordering. Freeze native answers before applying any selector.
const rows=[
  ['white','k7/8/8/8/8/2b3b1/3NNN2/4K3 w - -','d2','e2','f2','c3'],
  ['black','4k3/3nnn2/2B3B1/8/8/8/8/K7 b - -','d7','e7','f7','c6'],
];
const cases=rows.map(([id,fen,left,middle,right,capture])=>{
  const p=position(fen);
  assert.ok(!attacked(p.board,p.board.indexOf(p.turn+'k'),p.turn==='w'?'b':'w'));
  const native=legalMoves(p).filter(m=>p.board[m.from]===p.turn+'n').map(m=>squareName(m.from)+squareName(m.to)).sort();
  assert.ok(native.includes(middle+capture));
  assert.ok(native.every(m=>m.startsWith(middle)));
  const origin=squareOf(middle);
  assert.equal(p.board[origin],p.turn+'n');
  return {id,fen,firstPinned:left,lastPinned:right,free:middle,legalKnightMoves:native};
});
console.log(JSON.stringify({authority:'pinned Arcade legalMoves',cases},null,2));
