import assert from 'node:assert/strict';
import {attacks,gap} from './sources.mjs';
import {crossSources} from './cross.mjs';
import {mixedSources} from './material.mjs';
import {kingProjections} from './king.mjs';
import {protocolSources} from './lowering.mjs';

const axes=[[0,1,'Rank'],[1,0,'File'],[-1,1,'Rise'],[1,1,'Fall']];
const vectors=[[1,0,1],[0,1,10],[1,1,11],[-1,1,9]];

function recipe(kind, axis=null, distance=0) {
  const patterns=[],replacement=[];
  for(const [i,[x,y,stride]] of vectors.entries()) {
    const denominator=axis ? axis[0]*x+axis[1]*y : 0;
    const signed=denominator ? distance/denominator : 0;
    const capture=kind==='Capture' || kind==='Check' && distance===0 && denominator===0;
    for(const sign of [1,-1]) {
      const step=kind==='Step' ? 1 : Math.abs(signed);
      if(!capture && kind!=='Step' && (!Number.isInteger(step)||step<1||step>7||sign!==Math.sign(signed)))continue;
      const skip=gap(stride-1);
      const corridor=skip+(capture?'(?:,'+skip+')*':step===1?'':'(?:,'+skip+'){'+(step-1)+'}');
      const target=capture?'[prnbq]':'[,prnbq]';
      const label='ABCDEFGH'[2*i+(sign<0?1:0)];
      const move=sign>0?'S('+corridor+')'+target:target+'('+corridor+')S';
      const base=patterns.length*5;
      patterns.push(label+'(,)(X)([^;]*)'+move+'([^;]*);');
      // A successful match consumes its label, seed comma/X, entire board
      // and terminator. Unmatched alternatives contribute empty captures.
      for(const group of sign>0?[3,1,4,2,5]:[3,2,4,1,5])replacement.push('$'+(base+group));
    }
  }
  // An impossible near-diagonal intersection, as when d is odd and >7,
  // has no candidates. Keep the signed original board so it is rejected.
  return [patterns.join('|')||'Z',replacement.join('')+';'];
}

export function recordSources(variant) {
  const out={...mixedSources('all-minors-v9'),...protocolSources(variant)};
  const checks=crossSources('rook-cross-v2');
  for(const color of ['w','b']) {
    out['slideCheck'+color]=checks['slideCheck'+color];
    out['slideKing'+color]=kingProjections(color);
  }
  for(const axis of axes) {
    const length=axis[0] && axis[1] ? 14 : 7;
    const rows=Array.from({length:length*2+1},(_,i)=>recipe('Check',axis,i-length).join('@'));
    assert.ok(rows.every(row=>!row.includes('~')));
    const name='slideRecipe'+axis[2];
    out[name]=`function ${name}(d) { return '${rows.join('~')}'.split('~')[d+${length}].split('@'); }`;
  }
  for(const kind of ['Step','Capture']) {
    const name='slideRecipe'+kind;
    const [pattern,substitute]=recipe(kind);
    out[name]=`function ${name}() {return ['${pattern}','${substitute}'];}`;
  }
  const reject=side=>'[^;]*(?:S|'+attacks(side)+')[^;]*;';
  out.slideFailurePattern="function slideFailurePattern(white) { return white ? '"+reject('w')+"' : '"+reject('b')+"'; }";
  out.slideProject=`function slideProject(board,kind,recipe,rejected,origin) {
    let labels=kind=='r' ? 'ABCD' : kind=='b' ? 'EFGH' : 'ABCDEFGH';
    let originals=labels.replace('([A-H])','$1,X'+board+';');
    let first=originals.replace(recipe[0],recipe[1]).replace(rejected,'').split(';')[0];
    return first=='' ? -1 : origin*80+first.replace('X.*','').size();
  }`;
  return out;
}

export function recordBinding() {
  return `function slideOne(board,kind,direction,rejected) {
    let origin=board.replace('S.*','').size();
    let king=board.replace('K.*','').size();
    let dx=king%10-origin%10;
    let dy=king / 10 - origin / 10;
    let recipe=direction==1 ? slideRecipeRank(dy) : direction==2 ? slideRecipeFile(dx)
      : direction==3 ? slideRecipeRise(dy-dx) : direction==4 ? slideRecipeFall(dy+dx)
      : direction==0 ? slideRecipeStep() : slideRecipeCapture();
    return slideProject(board,kind,recipe,rejected,origin);
  }
  function slideTyped(text,board,direction,defender) {
    let prefix='.*'+defender;
    let kind=text.matches(prefix+'q,.*') ? 'q' : text.matches(prefix+'b,.*') ? 'b' : 'r';
    let two=board.matches('.*S.*S.*');
    let rejected=slideFailurePattern(defender=='w');
    let first=board.matches('.*S.*') ? slideOne(two ? board.replace('S([^S]*)S','S$1O') : board,kind,direction,rejected) : -1;
    return first>=0 || !two ? first : slideOne(board.replace('^([^S]*)S','$1O'),kind,direction,rejected);
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
