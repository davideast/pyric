import {familyRoute} from './cross.mjs';
import {gap,attacks} from './sources.mjs';

function pawnReply(color) {
  const positive = color === 'w';
  function project(prefix, stride, target, doubled=false) {
    const skip=gap(stride-1);
    const span='('+skip+(doubled?','+skip:'')+')';
    const expr=positive?'P'+span+target:target+span+'P';
    return "board.replace('"+prefix+expr+"','"+(prefix?'$1':'')+
      (positive?(prefix?',\u00242X':',\u00241X'):(prefix?'X\u00242,':'X\u00241,'))+"')";
  }
  // For a double push the pawn must start on rank 2 or 7. The negative
  // projection starts at its destination (rank 5 for a black double push).
  const base=positive?10:40;
  const moves=[project('',10,','),project('',9,'[prnbq]'),project('',11,'[prnbq]'),
    project('^(.{'+base+','+(base+7)+'})',10,',',true)];
  const invalid='(?:[^;]*P[^;]*|[^;]*'+attacks(color)+'[^;]*);';
  return 'function slidePawn'+color+"(board) {\n  let moves = ["+moves.join(',\n    ')+
    "].join(';')+';';\n  return !moves.matches('(?:"+invalid+")*');\n}";
}

export function extendedSources(kinds) {
  const out={};
  for(const color of ['w','b']) {
    const enemy=color==='w'?'b':'w';
    const other='(?:[,#]|'+enemy+'[prnbqk],|'+color+'k,)*';
    const slider=color+'['+kinds+'],';
    const pawn=color+'p,';
    // A bare king plus one slider may have one additional pawn. With a pawn,
    // exclude enemy pawns so an en-passant defense cannot exist in this scope.
    const clean='(?:[,#]|'+enemy+'[rnbqk],|'+color+'k,)*';
    const material=other+slider+other+'|'+clean+'(?:'+pawn+clean+slider+'|'+slider+clean+pawn+')'+clean;
    out['sliderMaterial'+color]="function sliderMaterial"+color+"(text) { return text.matches('"+material+"'); }";
    out['sliderEncode'+color]="function sliderEncode"+color+"(text) { return text.replace('"+color+
      "k,','K').replace('"+color+"[rbq],','S').replace('"+color+"p,','P').replace('"+enemy+
      "?([prnbqk#]),','$1'); }";
    out['slidePawn'+color]=pawnReply(color);
  }
  return out;
}

export function extendedBinding(kinds,optimized=false,variant='') {
  const fns=[];
  for(const color of ['w','b']) {
    for(const kind of kinds) {
      fns.push('function slideChoose'+kind+color+'(board,direction) {\n    return '+familyRoute(kind,color)+';\n  }');
    }
    const choose=[...kinds].reverse().map((kind,i)=>i===kinds.length-1?'slideChoose'+kind+color+'(board,direction)':
      "text.matches('.*"+color+kind+",.*') ? slideChoose"+kind+color+'(board,direction) : ').join('');
    fns.push('function slideTyped'+color+'(text,board,direction) {\n    return '+choose+';\n  }');
    const all=Array.from({length:4},(_,i)=>'allRefused'+color+i+'(records)').join(' && ');
    fns.push('function slideKing'+color+"(board) {\n    let fixed = board.replace('[SP]','X');\n    let records = fixed + ';' + fixed + ';';\n    return !("+all+');\n  }');
    fns.push('function slideStatus'+color+'(text,board,status) {\n    let direction = slideCheck'+color+'(board);\n    return '+
      "(status == 'playing' || ((direction==0) == (status=='draw'))) && ((slideTyped"+color+'(text,board,direction)>=0 || slideKing'+color+
      "(board) || (board.matches('.*P.*') && slidePawn"+color+"(board))) == (status=='playing'));\n  }");
    fns.push('function slideWitness'+color+'(text,board) { return slideTyped'+color+'(text,board,slideCheck'+color+'(board)); }');
  }
  fns.push("function sliderMove(text,defender) { return defender == 'w' ? slideWitnessw(text,sliderEncodew(text)) : slideWitnessb(text,sliderEncodeb(text)); }");
  fns.push("function sliderStatus(text,defender,status) { return defender == 'w' ? slideStatusw(text,sliderEncodew(text),status) : slideStatusb(text,sliderEncodeb(text),status); }");
  let joined=fns.join('\n  ');
  if(variant==='all-rights-king-v7') {
    for(const side of ['w','b']) {
      const cols='slideTyped'+side+'(text,board,direction)>=0 || slideKing'+side+'(board)';
      joined=joined.replace(cols,'(direction==0 ? slideKing'+side+'(board) || slideTyped'+side+'(text,board,direction)>=0 : '+cols+')');
    }
  }
  if(optimized && variant!=='all-packed-path-v5') joined=joined.replaceAll("(status == 'playing' || ((direction==0) == (status=='draw')))", 'slideMayClaim(status,direction)');
  return optimized ? joined.replaceAll('&& ((slideTyped','&& slideClaim(status, (slideTyped').replaceAll('&& (((direction==0','&& slideClaim(status, ((direction==0').replaceAll("(board))) == (status=='playing'));","(board))));") : joined;
}
