import {once} from './optimized.mjs';

export function compactPathSources() {
  // A vertical or diagonal line has at most six intermediate ranks.
  const steps=[1,2,3,4,5,6];
  const checked=square=>steps.map(r=>
    "(low >= "+r+" || high <= "+r+" || board["+square(r)+"] == '')"
  ).join('\n    && ');
  const bounds='  let low = y < toY ? y : toY;\n  let high = y < toY ? toY : y;';
  return {
    filePathClear:`function filePathClear(board,file,y,toY) {
${bounds}
  return ${checked(r=>"file + '"+(r+1)+"'")};
}`,
    diagonalPathClear:`function diagonalPathClear(board,x,y,toX,toY) {
${bounds}
  let rising = toX - x == toY - y;
  let intercept = rising ? x - y : x + y;
  let files = ['a','b','c','d','e','f','g','h'];
  return ${checked(r=>"files[rising ? intercept + "+r+" : intercept - "+r+"] + '"+(r+1)+"'")};
}`,
  };
}

export function compactValidation(source) {
  let result=source;
  const flags="[old.castling.matches('.*K.*'), old.castling.matches('.*Q.*'), old.castling.matches('.*k.*'), old.castling.matches('.*q.*')]";
  result=once(result,'castleBoard(old, next, color, dx > 0, '+flags+')','castleBoard(old, next, color, dx > 0)');
  result=once(result,'function castleBoard(old, next, color, kingSide, flags)','function castleBoard(old, next, color, kingSide)');
  result=once(result,"flags[(color == 'w' ? 0 : 2) + (kingSide ? 0 : 1)]",
    "old.castling.matches(color == 'w' ? (kingSide ? '.*K.*' : '.*Q.*') : (kingSide ? '.*k.*' : '.*q.*'))");
  result=once(result,'keptRights('+flags+', piece, mv.from, mv.to)','keptRights(old.castling, piece, mv.from, mv.to)');
  for(const [i,ch] of Array.from('KQkq').entries()) {
    // The capture/move conditions already determine whether this flag could survive.
    const match="flags["+i+"] && ";
    result=once(result,match,'');
    result=once(result," ? '"+ch+"' : '')"," && flags.matches('.*"+ch+".*') ? '"+ch+"' : '')");
  }
  return result;
}

export const compactPath="(dy == 0 ? horizontalPathClear(old.board, mv.from[1:2], x, x + dx) : dx == 0 ? filePathClear(old.board, mv.from[0:1], y, y + dy) : diagonalPathClear(old.board, x, y, x + dx, y + dy))";

/** Coalesce repeated seat and board reads inside the single Arcade move admission. */
export function compactAdmission(module) {
  let out=module;
  out=once(out,"  let color = old.currentTurn == 'host' ? 'w' : 'b';",
    "  let seat = old.currentTurn;\n  let color = seat == 'host' ? 'w' : 'b';");
  out=once(out,'isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()',
    "old.status == 'playing' && seat in ['host','guest'] && request.auth.uid == old[seat] && next.currentTurn == (seat == 'host' ? 'guest' : 'host') && next.moveCount == old.moveCount + 1");
  out=once(out,'next.lastMove.keys().hasOnly(', 'mv.keys().hasOnly(');
  out=once(out,"(target == '' || target[0:1] != color)\n    && (target == '' || target[1:2] != 'k')",
    "(target == '' || (target[0:1] != color && target[1:2] != 'k'))");
  out=once(out,'next.board.keys().hasOnly(old.board.keys())', 'next.board.keys().toSet() == old.board.keys().toSet()');
  out=once(out,'next.lastMove.extra))','mv.extra))');
  out=once(out,'&& priorPosition(old, next)', '&& next.prevBoard == old.board && next.prevCastling == old.castling && next.prevEnPassant == old.enPassant');
  out=once(out,"&& onlyFieldsChanged(['board',", "&& next.diff(old).affectedKeys().hasOnly(['board',");
  return out;
}
