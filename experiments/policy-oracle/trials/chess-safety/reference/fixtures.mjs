import {position} from '../../chess/reference/score.mjs';
import {squareName} from '../../chess/reference/arcade-reference.ts';
import {fresh,afterMove,movePatch} from '../../chess/verify/document.mjs';
import {fixedCreatedAt} from '../../for-of/live/fixtures.mjs';

// Construct what the SDK submits, including the hypothetical successor for a
// move the referee might refuse. This adapter reads no expected verdicts.
export function sample({fen,uci,claim}, writer, other) {
  const pos=position(fen);
  const white=pos.turn==='w';
  const board=Object.fromEntries(pos.board.map((piece,i)=>[squareName(i),piece]));
  const ep=pos.enPassant<0 ? '' : squareName(pos.enPassant);
  const before={...fresh(white?writer:other,fixedCreatedAt),guest:white?other:writer,
    currentTurn:white?'host':'guest',status:'playing',board,prevBoard:board,moveCount:16,
    castling:pos.castling,prevCastling:pos.castling,enPassant:ep,prevEnPassant:ep};
  const proposal=movePatch(afterMove(before,uci,undefined,false));
  if (claim) Object.assign(proposal,{status:claim.status,winner:claim.winner});
  return {before,proposal};
}
