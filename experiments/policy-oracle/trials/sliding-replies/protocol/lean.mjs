// Equivalent hot-path checks for the one chessMove() admission entry point.
import assert from 'node:assert/strict';
function change(source,before,after) {
  assert.equal(source.split(before).length,2,'Unexpected chess admission shape');
  return source.replace(before,()=>after);
}
export function lean(source) {
  const entry=source.split('match /databases/{database}/documents {')[1];
  assert.equal([...entry.matchAll(/\bchessMove\(\)/g)].length,1);
  assert.ok(entry.includes("allow update: if resource.data.status == 'playing' && request.resource.data.status in ['playing', 'won', 'draw'] && chessMove();"));
  source=change(source," && old.status == 'playing' && seat in"," && seat in");
  // Distinct squares follow from an empty origin and a non-empty destination.
  // The latter is the side's piece or a validated promotion of that side.
  source=change(source," && fromSquare != toSquare && piece[0:1] == color"," && piece[0:1] == color");
  const dest="next.board[toSquare] == (promo == '' ? piece : color + promo) && (promo == '' || piece == color + 'p' && promo in ['q', 'r', 'b', 'n'] && toSquare[1:2] == (color == 'w' ? '8' : '1'))";
  source=change(source,dest,"(promo == '' ? next.board[toSquare] == piece : next.board[toSquare] == color + promo && piece == color + 'p' && promo in 'q,r,b,n'.split(',') && toSquare[1:2] == (color == 'w' ? '8' : '1'))");
  for(const names of [['board','castling','enPassant','prevBoard','prevCastling','prevEnPassant','lastMove','currentTurn','moveCount','status','winner'],
                      ['from','to','promotion','extra']]) {
    const literal="['"+names.join("', '")+"']";
    source=change(source,'.hasOnly('+literal+')',".hasOnly('"+names.join(',')+"'.split(','))");
  }
  return source;
}
