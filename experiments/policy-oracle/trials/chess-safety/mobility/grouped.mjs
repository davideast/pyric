import {attackPattern} from '../policy/packed.mjs';

export function groupedSources() {
  const result={};
  for(const color of ['w','b']) {
    const name='anyKingReply'+color;
    const enemy=color==='w'?'b':'w';
    const target='(?:'+enemy+'[prnbq])?,';
    const moves=[10,11,1,-9,-10,-11,-1,9].map(offset=>{
      const gap='((?:[^,]*,){'+(Math.abs(offset)-1)+'})';
      // A successful move consumes the leading invalid flag and reproduces the
      // entire board with exactly one new king. A missed pattern retains X.
      const pat=offset>0
        ? '^X(.*)'+color+'k,'+gap+target+'(.*)$'
        : '^X((?:[^,]*,)*)'+target+gap+color+'k,(.*)$';
      const replacement=offset>0?'$1,$2'+color+'k,$3':'$1'+color+'k,$2,$3';
      return "original.replace('"+pat+"', '"+replacement+"')";
    });
    const attacked=attackPattern(color).replaceAll('.*','[^;]*').replaceAll('[^,]','[^,;]');
    const everyRefused='(?:(?:X[^;]*|'+attacked+');){8}';
    result[name]='function '+name+"(text) {\n  let original = 'X' + text;\n  let replies = [\n    "+
        moves.join(',\n    ')+"\n  ].join(';') + ';';\n  return !replies.matches('"+everyRefused+"');\n}";
  }
  return result;
}
