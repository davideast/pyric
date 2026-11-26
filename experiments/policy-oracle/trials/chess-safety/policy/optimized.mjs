/** Rewrite known, pinned Arcade helpers without changing their write contract. */
export function once(rules, before, after) {
  if (rules.split(before).length !== 2) throw Error('Unrecognized rule fragment: '+before);
  return rules.replace(before,after);
}

function replaceFunction(rules, name, next) {
  const expression=new RegExp('(?:export )?function '+name+'\\([^]*?\\n\\}','g');
  const functions=rules.match(expression);
  if(functions?.length!==1) throw Error('Expected one '+name+' helper');
  return rules.replace(functions[0],next);
}

export function optimizeApplication(module) {
  const start=module.indexOf('export function chessMove()');
  const end=module.indexOf('export function chessResign()');
  const before=module.slice(start,end);
  const cached=before.replaceAll('request.resource.data','next').replaceAll('resource.data','old');
  return once(module,before,cached.replace('export function chessMove() {',`export function chessMove() {
  let old = resource.data;
  let next = request.resource.data;`));
}

export function optimizeValidation(source) {
  let result=replaceFunction(source,'pieceShape',`export function pieceShape(kind, color, dx, dy, target, home, enPassant) {
  let forward = color == 'w' ? 1 : -1;
  return kind == 'r' ? dx == 0 || dy == 0
    : kind == 'b' ? dx == dy || dx + dy == 0
    : kind == 'q' ? dx == 0 || dy == 0 || dx == dy || dx + dy == 0
    : kind == 'n' ? dx * dy in [-2, 2]
    : kind == 'p' ? (dx == 0 && target == '' && (dy == forward || (home && dy == 2 * forward)))
      || (dx in [-1, 1] && dy == forward && (target != '' || enPassant))
    : kind == 'k' && ((dx in [-1,0,1] && dy in [-1,0,1]) || (dy == 0 && dx in [-2,2]));
}`);
  // chessMove verifies distinct source and destination for every piece above.
  const flags="[old.castling.matches('.*K.*'), old.castling.matches('.*Q.*'), old.castling.matches('.*k.*'), old.castling.matches('.*q.*')]";
  result=once(result,'  let flags = '+flags+';', '');
  result=once(result,"castleBoard(old, next, color, dx > 0, flags)",'castleBoard(old, next, color, dx > 0, '+flags+')');
  result=once(result,"next.castling == keptRights(flags, piece, mv.from, mv.to)",
    "(old.castling == '' ? next.castling == '' : next.castling == keptRights("+flags+", piece, mv.from, mv.to))");
  // Adjacent moves have no intermediate squares; a knight's path is unchecked.
  result=once(result,"castle || kind == 'n' || pathClear(old.board, x, y, dx, dy)",
    "castle || kind == 'n' || (dx in [-1,0,1] && dy in [-1,0,1]) || pathClear(old.board, x, y, dx, dy)");
  return result;
}
