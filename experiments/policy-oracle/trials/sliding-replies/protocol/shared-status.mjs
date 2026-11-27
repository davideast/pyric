// The two existing geometry paths return their checked board to one admission call.
import assert from 'node:assert/strict';
function replace(source,from,to) {
  assert.equal(source.split(from).length,2,'Expected one protocol fragment: '+from.slice(0,72));
  return source.replace(from,()=>to);
}
export function linkSharedStatus(source,dense) {
  const slow='packedSafe(text, color) && admittedStatus(castle ? castleFinish(text, color, xTo) : text, color, next.status)';
  source=replace(source,slow,'packedSafe(text, color) ? [castle ? castleFinish(text, color, xTo) : text, false] : []');
  const travel='packedSafe(text,color) && '+(dense?'denseSliderStatus':'admittedStatus')+'(text,color,next.status);';
  source=replace(source,travel,'packedSafe(text,color) ? [text, true] : [];');
  const safe='_games_chess_chess_helpers__safeTransition(old, next, color, castle, x + dx)';
  source=replace(source,' && '+safe+';', ' ? '+safe+' : [];');
  const gate=dense?'denseSliderStatus(frame[0],color,status,frame[1])':'admittedStatus(frame[0],color,status)';
  const marker='  function chessMove() {';
  source=replace(source,marker,`  function checkedReplyStatus(frame,color,status) {
    return frame.size()==2 && ${gate};
  }
`+marker);
  if(dense) {
    source=replace(source,'function denseSliderStatus(text,color,status) {','function denseSliderStatus(text,color,status,normal) {');
    source=replace(source,"return (color=='w'? text.matches('.*bp,.*bp,.*') && denseNoInterpositionb(text)",
                   "return normal && (color=='w'? text.matches('.*bp,.*bp,.*') && denseNoInterpositionb(text)");
  }
  const start=" && (piece.matches('[wb][rbq]') && ";
  source=replace(source,start," && checkedReplyStatus((piece.matches('[wb][rbq]') && ");
  const end=" : boardTransition(old, next, mv, piece, color, fromSquare, toSquare)) && old.status";
  return replace(source,end," : boardTransition(old, next, mv, piece, color, fromSquare, toSquare)),color,next.status) && old.status");
}
