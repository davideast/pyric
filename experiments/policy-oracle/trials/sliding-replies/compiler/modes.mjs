import {gap} from './sources.mjs';
import {solverSources} from './solver.mjs';

const axes=[[0,1],[1,0],[-1,1],[1,1]];
const rays=[[1,0,1],[0,1,10],[1,1,11],[-1,1,9]];

// Integer mode encoding: 15=impossible; 15+n is an intersection n signed
// ray steps from S. 31 is the pair of neighboring steps; 32 is the pair
// of nearest captures. Encode four columns for each (line,distance) entry.
function modes(axis,distance) {
  return rays.map(([x,y])=>{
    const denominator=axis[0]*x+axis[1]*y;
    if(!denominator)return distance===0?32:15;
    const n=distance/denominator;
    return Number.isInteger(n)&&Math.abs(n)<=7?15+n:15;
  }).join(',');
}

function lookupSource(stride) {
  const skip=gap(stride-1);
  const table=Array.from({length:31},(_,i)=>{
    const n=i-15,length=Math.abs(n);
    if(!n||length>7&&length!==15)return '(Z)';
    const tail=length===15?'(?:,'+skip+')*':length>1?'(?:,'+skip+'){'+(length-1)+'}':'';
    const between='('+skip+tail+')',to=length===15?'[prnbq]':'[,prnbq]';
    return n>0?'S'+between+to:to+between+'S';
  });
  return `function slideVector${stride}(board,code) {
    let patterns='${table.join('~')}'.split('~');
    return code==15 ? 'S' : code<31
      ? board.replace(patterns[code],code>15 ? ',$1X' : 'X$1,')
      : board.replace(patterns[code==31 ? 16 : 30],',$1X')+';'+board.replace(patterns[code==31 ? 14 : 0],'X$1,');
  }`;
}

export function modeSources(variant) {
  const out=solverSources(variant);
  const rows=[];
  for(let d=-14;d<=14;d++)for(const axis of axes)rows.push(modes(axis,d));
  out.slideModes=`function slideModes(origin,king,direction) {
    let dx=king%10-origin%10;
    let dy=king / 10 - origin / 10;
    let d=direction==1 ? dy : direction==2 ? dx : direction==3 ? dy-dx : dy+dx;
    return direction==0 ? ['31','31','31','31'] : direction==5 ? ['32','32','32','32']
      : '${rows.join('~')}'.split('~')[(d+14)*4+direction-1].split(',');
  }`;
  for(const [,,stride] of rays)out['slideVector'+stride]=lookupSource(stride);
  return out;
}

export function modeBinding() {
  return `function slideOne(board,kind,direction,rejected) {
    let origin=board.replace('S.*','').size();
    let modes=slideModes(origin,board.replace('K.*','').size(),direction);
    let straight=kind=='b' ? 'S' : slideVector1(board,int(modes[0]))+';'+slideVector10(board,int(modes[1]));
    let diagonal=kind=='r' ? 'S' : slideVector11(board,int(modes[2]))+';'+slideVector9(board,int(modes[3]));
    return slideClassify(straight+';'+diagonal,rejected,origin);
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
