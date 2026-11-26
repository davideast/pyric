import assert from 'node:assert/strict';
import {packedSources} from '../policy/packed.mjs';
import {terminalEnvelope} from './three-piece.mjs';

const nonKings="function otherDefenders(text,white) { return text.matches(white ? '.*b[pqrbn],.*' : '.*w[pqrbn],.*'); }";

// On a physically validated castle the virtual packed board has exactly three
// adjacent moving-side king markers and its original rook at the relevant end.
export const finishCastle=`function castleFinish(text,color,xTo) {
  return color == 'w'
    ? (xTo == 6 ? text.replace('wk,wk,wk,wr,',',wr,wk,,') : text.replace('wr,,wk,wk,wk,',',,wk,wr,,'))
    : (xTo == 6 ? text.replace('bk,bk,bk,br,',',br,bk,,') : text.replace('br,,bk,bk,bk,',',,bk,br,,'));
}`;

export function compileBare(compileFunction,mobility) {
  const extra=compileFunction(nonKings),pack=compileFunction(packedSources(true).packNormal);
  return function bareDefenderStatus(board,color) {
    if(extra(pack(board),color==='w'))return null;
    const defender=color==='w'?'b':'w';
    return mobility.hasReply(board,defender)?'playing':mobility.inCheck(board,defender)?'won':'draw';
  };
}

export function bareBinding(source) {
  assert.equal(source,'return packedSafe(text, color);');
  const test='return packedSafe(text, color) && admittedStatus(castle ? castleFinish(text,color,xTo) : text,color,next.status);';
  // An exact existing lower bound for king + one Q/R/B/N versus a bare king.
  // Boards with more material pass through the unrestricted king-reply check.
  const sparse="'(?:[,#]|[wb]k,)*(?:[wb][qrbn],(?:[,#]|[wb]k,)*)?'";
  const helpers=finishCastle+nonKings+`
    function admittedStatus(text,color,status) {
      let white = color == 'w';
      let defender = white ? 'b' : 'w';
      return status == 'playing'
        ? otherDefenders(text,white)
          || (!text.matches('${terminalEnvelope()}') && text.matches(${sparse}))
          || hasKingReply(text,defender)
        : packedSafe(text,defender) == (status=='draw') && !replyCapture(text,color)
          && !hasKingReply(text,defender);
    }`;
  return {test,helpers};
}
