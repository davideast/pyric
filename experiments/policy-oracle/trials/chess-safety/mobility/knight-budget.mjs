import assert from 'node:assert/strict';

// Both square identifiers are read throughout match admission and geometry.
// Evaluate each once and pass it through the existing transition. The target
// occupant and color-sensitive pawn arithmetic are used only on pawn moves.
export function specializeAdmission(rules,{pawnPriority=false}={}) {
  const section=(name)=> {
    const matches=rules.match(new RegExp('  function '+name+'\\([^\\n]*?\\) \\{[\\s\\S]*?\\n  \\}','g'));
    assert.equal(matches?.length,1,'expected one '+name+' function');
    return matches[0];
  };
  const edit=(source,old,newValue)=>{
    assert.equal(source.split(old).length,2,'unexpected admission binding '+old);
    return source.replace(old,()=>newValue);
  };
  const chess=section('chessMove');
  let updated=chess.replaceAll('mv.from','fromSquare').replaceAll('mv.to','toSquare');
  updated=edit(updated,'let mv = next.lastMove;','let mv = next.lastMove;\n    let fromSquare = mv.from;\n    let toSquare = mv.to;');
  updated=edit(updated,'boardTransition(old, next, mv, piece, color)', 'boardTransition(old, next, mv, piece, color, fromSquare, toSquare)');
  const winner="next.winner == (next.status == 'won' ? old.currentTurn : '')";
  updated=edit(updated,' && '+winner,'');
  updated=edit(updated,'request.auth != null && ','request.auth != null && '+winner+' && ');
  rules=rules.replace(chess,()=>updated);

  const original=section('boardTransition');
  let move=original.replaceAll('mv.from','fromSquare').replaceAll('mv.to','toSquare');
  move=edit(move,'boardTransition(old, next, mv, piece, color)','boardTransition(old, next, mv, piece, color, fromSquare, toSquare)');
  move=edit(move,"    let home = y == (color == 'w' ? 1 : 6);\n",'');
  const piece=section('pieceShape');
  const expression=piece.match(/\n    return (.*);\n/)[1];
  const [prefix,last]=expression.split(": kind == 'p' ? ");
  const [pawn,king]=last.split(" : kind == 'k' && ");
  assert.ok(prefix&&pawn&&king);
  const pawnFn="  function pawnMotion(color, dx, dy, target, y, enPassant) {\n"+
    "    let forward = color == 'w' ? 1 : -1;\n    return "+pawn.replace('home',"y == (color == 'w' ? 1 : 6)")+";\n  }";
  const shape="("+prefix+": kind == 'p' ? pawnMotion(color,dx,dy,old.board[toSquare],y,ep) : kind == 'k' && "+king+")";
  move=edit(move,'pieceShape(kind, color, dx, dy, old.board[toSquare], home, ep)',shape);
  rules=rules.replace(piece,()=>pawnFn).replace(original,()=>move);

  // The checked/dead-status arm already knows the defender. A missing knight
  // short-circuits here before computing any packed ordinal layers.
  const absence="(defender == 'w' ? (!text.matches('.*wn,.*') || !knightPairsw(knightRowsw0(text))) : (!text.matches('.*bn,.*') || !knightPairsb(knightRowsb0(text))))";
  const claim=section('admittedStatus');
  let scoped=edit(claim,'!knightWitness(text, defender)',absence);
  if(pawnPriority) {
    // At most one nonking family is evaluated on a terminal declaration.
    // Mixed pawn/knight positions belong to the pawn witness. A future
    // compiler may enforce both there if it can pay their complete cost.
    const hasPawn="text.matches('.*' + defender + 'p,.*')";
    const pawn="(defender == 'w' ? !pawnReplyw(text) : !pawnReplyb(text))";
    const original="(!"+hasPawn+" || "+pawn+") && "+absence;
    scoped=edit(scoped,original,"("+hasPawn+" ? "+pawn+" : "+absence+")");
  }
  return rules.replace(claim,()=>scoped);
}
