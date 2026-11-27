import assert from 'node:assert/strict';
import {attacks} from './sources.mjs';
import {crossSources,familyRoute} from './cross.mjs';
import {mixedSources} from './material.mjs';
import {protocolSources} from './lowering.mjs';

const rejected = color => '[^;]*(?:S|'+attacks(color)+')[^;]*;';

export function sharedSources(variant) {
  const out={...mixedSources('all-minors-v9'),...protocolSources(variant)};
  const definitions=crossSources(variant);
  for(const color of ['w','b']) out['slideCheck'+color]=definitions['slideCheck'+color];
  for(const [name,source] of Object.entries(definitions)) {
    if(!name.endsWith('w')||name.startsWith('slideCheck'))continue;
    const shared=name.slice(0,-1);
    // Square displacements, obstacles and friendly pieces have identical
    // geometry for both defenders. Only the enemy pawn attack direction differs.
    const neutral=side=>definitions[shared+side]
      .replace(shared+side+'(board)',shared+'(board,rejected)')
      .replace("'"+rejected(side)+"'",'rejected');
    assert.equal(neutral('w'),neutral('b'),'side-specific geometry in '+shared);
    assert.ok(source.includes(rejected('w')));
    out[shared]=neutral('w');
  }
  out.slideFailurePattern="function slideFailurePattern(white) { return white ? '"+rejected('w')+"' : '"+rejected('b')+"'; }";
  return out;
}

export function sharedBinding() {
  const functions=[];
  for(const kind of 'rbq') {
    const choices=familyRoute(kind,'').replaceAll('(board)','(board,rejected)');
    functions.push('function slideChoose'+kind+'(board,direction,rejected) { return '+choices+'; }');
  }
  functions.push(`function slideRooks(board,direction,rejected) {
    let first=slideChooser(board.replace('S([^S]*)$','O$1'),direction,rejected);
    return first>=0 ? first : slideChooser(board.replace('^([^S]*)S','$1O'),direction,rejected);
  }`);
  for(const color of ['w','b']) {
    functions.push(`function slideTyped${color}(text,board,direction) {
      let rejected=slideFailurePattern(${color==='w'});
      return text.matches('.*${color}q,.*') ? slideChooseq(board,direction,rejected)
        : text.matches('.*${color}b,.*') ? slideChooseb(board,direction,rejected)
        : board.matches('.*S.*S.*') ? slideRooks(board,direction,rejected)
        : board.matches('.*S.*') ? slideChooser(board,direction,rejected) : -1;
    }`);
    const all=Array.from({length:4},(_,i)=>'allRefused'+color+i+'(records)').join(' && ');
    functions.push(`function slideKing${color}(board) {
      let fixed=board.replace('[SPNO]','X');
      let records=fixed+';'+fixed+';';
      return !(${all});
    }`);
    functions.push(`function slideStatus${color}(text,board,status) {
      let direction=slideCheck${color}(board);
      return slideMayClaim(status,direction) && slideClaim(status,
        slideKing${color}(board) || slideTyped${color}(text,board,direction)>=0
        || (board.matches('.*[PN].*') && (board.matches('.*P.*') ? slidePawn${color}(board) : slideKnight${color}(board))));
    }`);
    functions.push('function slideWitness'+color+'(text,board) { return slideTyped'+color+'(text,board,slideCheck'+color+'(board)); }');
  }
  functions.push("function sliderMove(text,defender) { return defender=='w' ? slideWitnessw(text,sliderEncodew(text)) : slideWitnessb(text,sliderEncodeb(text)); }");
  functions.push("function sliderStatus(text,defender,status) { return defender=='w' ? slideStatusw(text,sliderEncodew(text),status) : slideStatusb(text,sliderEncodeb(text),status); }");
  return functions.join('\n  ');
}
