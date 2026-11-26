import * as arcade from '../../../chess/reference/arcade-reference.ts';

// An opposing defender that could capture or interpose but would uncover a
// slider attack on its king is a distinct terminal-evidence family.
function pinnedDefender(p) {
  return p.board.some((piece,i)=>{
    if(!piece || piece[0]!==p.turn || piece[1]==='k') return false;
    const b=[...p.board];b[i]='';
    return !arcade.inCheck(p) && arcade.inCheck({...p,board:b});
  });
}
export function bucket(next,replies) {
  const check=arcade.inCheck(next);
  if(replies.length===0) return (check?'mate':'stalemate')+(pinnedDefender(next)?'-pinned-defender':'');
  if(replies.length!==1) return null;
  const uci=replies[0], kind=next.board[arcade.squareOf(uci.slice(0,2))][1];
  const action=next.board[arcade.squareOf(uci.slice(2,4))]?'capture':'move';
  return ['only',kind,action,check?'in-check':'unchecked'].join('-');
}
