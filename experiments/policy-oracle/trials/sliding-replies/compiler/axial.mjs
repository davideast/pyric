import {compactAxes,crossSources} from './cross.mjs';
import {mixedSources} from './material.mjs';
import {kingProjections} from './king.mjs';
import {attacks} from './sources.mjs';
import {protocolSources} from './lowering.mjs';

export function axialSources(variant) {
  const out={...mixedSources('all-minors-v9'),...protocolSources(variant),...compactAxes()};
  const checks=crossSources('rook-cross-v2');
  for(const side of ['w','b']){
    out['slideCheck'+side]=checks['slideCheck'+side];
    out['slideKing'+side]=kingProjections(side);
  }
  const failure=side=>'[^;]*(?:S|'+attacks(side)+')[^;]*;';
  out.slideFailurePattern="function slideFailurePattern(white) { return white ? '"+failure('w')+"' : '"+failure('b')+"'; }";
  return out;
}

export function axialBinding() {
  return `function slideAxes(board,kind,direction,rejected) {
    return direction==1 ? slideRank(board,kind,rejected)
      : direction==2 ? slideFile(board,kind,rejected)
      : direction==3 ? slideRise(board,kind,rejected)
      : direction==4 ? slideFall(board,kind,rejected)
      : direction==0 ? slideStep(board,kind,rejected) : slideCapture(board,kind,rejected);
  }
  function slideBoth(board,kind,direction,rejected) {
    let first=slideAxes(board.replace('S([^S]*)S','S$1O'),kind,direction,rejected);
    return first>=0 || !board.matches('.*S.*S.*') ? first
      : slideAxes(board.replace('^([^S]*)S','$1O'),kind,direction,rejected);
  }
  function slideTyped(text,board,direction,defender) {
    let prefix='.*'+defender;
    let kind=text.matches(prefix+'q,.*') ? 'q' : text.matches(prefix+'b,.*') ? 'b' : 'r';
    return board.matches('.*S.*') ? slideBoth(board,kind,direction,slideFailurePattern(defender=='w')) : -1;
  }
  function sliderMove(text,defender) {
    let white=defender=='w';
    let board=white ? sliderEncodew(text) : sliderEncodeb(text);
    return slideTyped(text,board,white ? slideCheckw(board) : slideCheckb(board),defender);
  }
  function sliderStatus(text,defender,status) {
    let white=defender=='w';
    let board=white ? sliderEncodew(text) : sliderEncodeb(text);
    let direction=white ? slideCheckw(board) : slideCheckb(board);
    return slideMayClaim(status,direction) && slideClaim(status,
      (white ? slideKingw(board) : slideKingb(board)) || slideTyped(text,board,direction,defender)>=0
      || (board.matches('.*[PN].*') && (board.matches('.*P.*') ? (white ? slidePawnw(board) : slidePawnb(board))
        : (white ? slideKnightw(board) : slideKnightb(board)))));
  }`;
}
