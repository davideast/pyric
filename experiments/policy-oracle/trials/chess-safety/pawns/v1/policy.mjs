import {attackPattern} from '../../policy/packed.mjs';

// Prefix and suffix anchor every rewrite to one complete board. A greedy prefix
// selects one candidate per direction, even if several pawns can move that way.
// An unmoved X marks a direction whose geometric rewrite did not apply.
export function projections(color,first=false) {
  const other = color === 'w' ? 'b' : 'w';
  return [9,10,11].map(stride => {
    const target = stride === 10 ? ',' : other+'[prnbq],';
    const middle = '((?:[^,]*,){'+(stride-1)+'})';
    const prefix = first ? '^X((?:[^,]*,)*?)' : '^X((?:[^,]*,)*)';
    const suffix = '(.*)$';
    const pawn = color+'p,';
    const pat = prefix+(color==='w'?pawn+middle+target:target+middle+pawn)+suffix;
    const replacement = color==='w'?'$1,$2'+pawn+'$3':'$1'+pawn+'$2,$3';
    return `original.replace('${pat}', '${replacement}')`;
  });
}
export function sources(paired=false) {
  return Object.fromEntries(['w','b'].map(color=>{
    const name='pawnReply'+color;
    const attack=attackPattern(color).replaceAll('.*','[^;]*').replaceAll('[^,]','[^,;]');
    const moves=projections(color);
    if(paired)moves.push(...projections(color,true));
    const noWitness='(?:(?:X[^;]*|'+attack+');){'+moves.length+'}';
    const source=`function ${name}(text) {\n  let original = 'X' + text;\n  let candidates = [${moves.join(',\n    ')}].join(';') + ';';\n  return !candidates.matches('${noWitness}');\n}`;
    return [name,source];
  }));
}
