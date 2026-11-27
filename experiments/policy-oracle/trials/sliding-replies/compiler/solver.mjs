import {gap,attacks} from './sources.mjs';
import {crossSources} from './cross.mjs';
import {mixedSources} from './material.mjs';
import {kingProjections} from './king.mjs';
import {protocolSources} from './lowering.mjs';

// Each signed table entry is a move of this many ray steps from S. The
// special endpoints +/-15 select the first capturable piece on a ray.
// Zero, distances 8..14 and off-board positions produce no successor.
function vectorSource(stride) {
  const skip=gap(stride-1);
  const table=Array.from({length:31},(_,i)=>{
    const step=i-15,length=Math.abs(step);
    if(!length || length>7 && length!==15)return '(Z)';
    const capture=length===15;
    const between=skip+(capture?'(?:,'+skip+')*':length===1?'':'(?:,'+skip+'){'+(length-1)+'}');
    const target=capture?'[prnbq]':'[,prnbq]';
    return step>0?'S('+between+')'+target:target+'('+between+')S';
  });
  return `function slideVector${stride}(board,mode) {
    let patterns='${table.join('~')}'.split('~');
    let step=mode<16 ? mode : mode==16 ? 1 : 15;
    return mode==0 ? 'S' : board.replace(patterns[15+step],step>0 ? ',$1X' : 'X$1,')
      + (mode>=16 ? ';'+board.replace(patterns[15-step],'X$1,') : '');
  }`;
}

export function solverSources(variant) {
  const out={...mixedSources('all-minors-v9'),...protocolSources(variant)};
  const cross=crossSources(variant);
  for(const color of ['w','b']) {
    out['slideCheck'+color]=cross['slideCheck'+color];
    out['slideKing'+color]=kingProjections(color);
  }
  for(const stride of [1,10,11,9])out['slideVector'+stride]=vectorSource(stride);
  const rejected=side=>'[^;]*(?:S|'+attacks(side)+')[^;]*;';
  out.slideFailurePattern="function slideFailurePattern(white) { return white ? '"+rejected('w')+"' : '"+rejected('b')+"'; }";
  // A line check constrains the reply to one intersection on each allowed
  // slider axis. A collinear source can only take the checker. For a quiet
  // position it suffices to test the nearest step on each ray. For a leaper
  // check the only non-king response is a capture.
  out.slideModes=`function slideModes(origin,king,direction) {
    let dx=king%10-origin%10;
    let dy=king / 10 - origin / 10;
    let d=direction==1 ? dy : direction==2 ? dx : direction==3 ? dy-dx : dy+dx;
    let aligned=d==0 ? 17 : 0;
    let half=d%2==0 ? d / 2 : 0;
    return direction==0 ? [16,16,16,16] : direction==5 ? [17,17,17,17] : [
      direction==1 ? aligned : direction==3 ? -d : d,
      direction==2 ? aligned : d,
      direction==3 ? aligned : direction==4 ? half : d,
      direction==4 ? aligned : direction==3 ? half : direction==2 ? -d : d
    ];
  }`;
  out.slideClassify=`function slideClassify(records,rejected,origin) {
    let first=(records+';').replace(rejected,'').split(';')[0];
    return first=='' ? -1 : origin*80+first.replace('X.*','').size();
  }`;
  return out;
}

export function solverBinding() {
  const functions=[`function slideOne(board,kind,direction,rejected) {
    let origin=board.replace('S.*','').size();
    let king=board.replace('K.*','').size();
    let modes=slideModes(origin,king,direction);
    let straight=kind=='b' ? 'S' : slideVector1(board,modes[0])+';'+slideVector10(board,modes[1]);
    let diagonal=kind=='r' ? 'S' : slideVector11(board,modes[2])+';'+slideVector9(board,modes[3]);
    return slideClassify(straight+';'+diagonal,rejected,origin);
  }`,`function slideBoth(board,kind,direction,rejected) {
    let first=slideOne(board.replace('S([^S]*)S','S$1O'),kind,direction,rejected);
    return first>=0 || !board.matches('.*S.*S.*') ? first
      : slideOne(board.replace('^([^S]*)S','$1O'),kind,direction,rejected);
  }`];
  for(const color of ['w','b']) {
    functions.push(`function slideTyped${color}(text,board,direction) {
      let kind=text.matches('.*${color}q,.*') ? 'q' : text.matches('.*${color}b,.*') ? 'b' : 'r';
      return board.matches('.*S.*') ? slideBoth(board,kind,direction,slideFailurePattern(${color==='w'})) : -1;
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
