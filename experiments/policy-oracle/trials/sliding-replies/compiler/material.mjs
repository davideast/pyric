import {familyRoute} from './cross.mjs';
import {attacks,gap} from './sources.mjs';
import {extendedSources} from './family.mjs';

// Only evaluate this policy on positions whose entire defending material
// is covered. A second friendly rook remains an occupied square on every
// candidate for the first rook, and vice versa. A single friendly knight
// can defend independently of a slider and can also pin or obstruct it.
export function mixedSources() {
  const sources=extendedSources('rbq');
  for(const color of ['w','b']) {
    const enemy = color==='w'?'b':'w';
    const other = '(?:[,#]|'+enemy+'[prnbqk],|'+color+'k,)*';
    const rook=color+'r,', slider=color+'[rbq],', knight=color+'n,';
    const pair=other+'(?:'+rook+other+rook+'|'+slider+other+knight+'|'+knight+other+slider+')'+other;
    sources['sliderMaterial'+color]=sources['sliderMaterial'+color].replace("'); }",'|'+pair+"'); }");
    sources['sliderEncode'+color]=sources['sliderEncode'+color].replace(".replace('"+enemy+"?",".replace('"+color+"n,','N').replace('"+enemy+"?");
    const attempts=[];
    for(const offset of [8,12,19,21]){
      const skip='('+gap(offset-1)+')';
      attempts.push("board.replace('N"+skip+"[,prnbq]',',$1X')","board.replace('[,prnbq]"+skip+"N','X$1,')");
    }
    const bad='(?:[^;]*N[^;]*|[^;]*'+attacks(color)+'[^;]*);';
    sources['slideKnight'+color]='function slideKnight'+color+'(board) {\n  let candidates=['+attempts.join(',\n    ')+
      "].join(';')+';';\n  return !candidates.matches('(?:"+bad+")*');\n}";
  }
  return sources;
}

export function mixedBinding() {
  const functions=[];
  for(const color of ['w','b']) {
    for (const kind of 'rbq') {
      functions.push('function slideChoose'+kind+color+'(board,direction) { return '+familyRoute(kind,color)+'; }');
    }
    const typed='slideTyped'+color;
    const one=kind=>'slideChoose'+kind+color;
    functions.push(`function slideRooks${color}(board,direction) {
      let first = ${one('r')}(board.replace('S([^S]*)$','O$1'),direction);
      return first>=0 ? first : ${one('r')}(board.replace('^([^S]*)S','$1O'),direction);
    }`);
    functions.push(`function ${typed}(text,board,direction) {
      return text.matches('.*${color}q,.*') ? ${one('q')}(board,direction)
        : text.matches('.*${color}b,.*') ? ${one('b')}(board,direction)
        : board.matches('.*S.*S.*') ? slideRooks${color}(board,direction) : ${one('r')}(board,direction);
    }`);
    const all=Array.from({length:4},(_,i)=>'allRefused'+color+i+'(records)').join(' && ');
    functions.push(`function slideKing${color}(board) {
      let fixed=board.replace('[SPNO]','X');
      let records=fixed+';'+fixed+';';
      return !(${all});
    }`);
    functions.push(`function slideStatus${color}(text,board,status) {
      let direction = slideCheck${color}(board);
      return slideMayClaim(status,direction) && slideClaim(status,
        (direction==0 ? slideKing${color}(board) || ${typed}(text,board,direction)>=0
          : ${typed}(text,board,direction)>=0 || slideKing${color}(board))
        || (board.matches('.*[PN].*') && (board.matches('.*P.*') ? slidePawn${color}(board) : slideKnight${color}(board))));
    }`);
    functions.push('function slideWitness'+color+'(text,board) { return '+typed+'(text,board,slideCheck'+color+'(board)); }');
  }
  functions.push("function sliderMove(text,defender) { return defender=='w' ? slideWitnessw(text,sliderEncodew(text)) : slideWitnessb(text,sliderEncodeb(text)); }");
  functions.push("function sliderStatus(text,defender,status) { return defender=='w' ? slideStatusw(text,sliderEncodew(text),status) : slideStatusb(text,sliderEncodeb(text),status); }");
  return functions.join('\n  ');
}
