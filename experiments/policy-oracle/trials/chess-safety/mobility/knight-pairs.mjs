import {attackPattern} from '../policy/packed.mjs';

const leaps=[8,12,19,21,-8,-12,-19,-21];
function projects(color) {
  const n=color+'n,',enemy=color==='w'?'b':'w',to='(?:'+enemy+'[prnbq])?,';
  const expressions=leaps.map(d=>{
    const prefix=d>0?'[^;]':'(?:[^,;]*,)';
    const lead='(?:F('+prefix+'*?)|L('+prefix+'*))';
    const gap='((?:[^,;]*,){'+(Math.abs(d)-1)+'})';
    const pattern=lead+(d>0?n+gap+to:to+gap+n)+'([^;]*;)';
    const replacement=d>0?'$1$2,$3'+n+'$4':'$1$2'+n+'$3,$4';
    return "records.replace('"+pattern+"','"+replacement+"')";
  });
  const danger=attackPattern(color).replaceAll('.*','[^;]*').replaceAll('[^,]','[^,;]');
  // Failed projections retain their F/L source markers. Every record ends in
  // an explicit separator, so a successful escape breaks the full match.
  return "function knightPairs"+color+"(records) { let moves=["+expressions.join(',')+
    "].join(''); return !moves.matches('(?:(?:[FL][^;]*|"+danger+");)+'); }";
}

export function pairSources(all=false) {
  const result={};
  for(const color of ['w','b']) {
    result['knightPairs'+color]=projects(color);
    if(all)result['maskKnights'+color]="function maskKnights"+color+"(text) { return text.replace('^(.*?)"+
      color+"n,','$1"+color+"p,').replace('^(.*)"+color+"n,','$1"+color+"p,'); }";
  }
  return result;
}

export function pairHelper(all=false) {
  const arms=[];
  for(const color of ['w','b']) {
    const n=color+'n,';
    const any="'.*"+n+".*'",three="'.*"+n+".*"+n+".*"+n+".*'";
    const rows="'F'+text+';L'+text+';'";
    if(all) {
      // Eight pawn promotions plus two original knights put ten on one side.
      // Each next tier masks two eligible sources as same-color blockers.
      for(let tier=4;tier>=0;tier--){
        const tail=tier===4?rows:"("+rows+")+(text.matches("+three+")?knightRows"+color+(tier+1)+"(maskKnights"+color+"(text)):'')";
        arms.push('function knightRows'+color+tier+'(text) {return '+tail+';}');
      }
    }
    arms.push('function knightWitness'+color+'(text) { return text.matches('+any+') && knightPairs'+color+'('+
      (all?'knightRows'+color+'0(text)':rows)+'); }');
  }
  return arms.join('\n')+"\nfunction knightWitness(text,color) {return color=='w' ? knightWitnessw(text) : knightWitnessb(text);}";
}

// For diagnostic UCI witnesses, replay the same selection on each masked
// board. A knight left on its square blocks an enemy exactly like a friendly
// pawn; no move here changes the material on the submitted application board.
export function pairStandalone(api,all) {
  const compiled=Object.fromEntries(Object.entries(pairSources(all)).map(([name,s])=>[name,api(s)]));
  function layers(text,color){
    const out=[text],n=color+'n,';
    while(all&&out.length<5&&text.split(n).length>3) {
      text=compiled['maskKnights'+color](text);
      out.push(text);
    }
    return out;
  }
  return {compiled,layers,hasReply(text,color) {
    return text.includes(color+'n,') && compiled['knightPairs'+color](layers(text,color).map(t=>'F'+t+';L'+t+';').join(''));
  }};
}
