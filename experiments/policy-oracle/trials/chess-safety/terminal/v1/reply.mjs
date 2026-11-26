// If the last mover has only a king and one slider, a defending nonking
// piece that can capture the slider has a legal reply: only the (nonadjacent)
// kings could give check after the capture. Other defending pieces may remain.
function replies(color){
  const enemy=color==='w'?'b':'w';
  const target=color+'[rq],', pair=[];
  const gap=n=>n?'(?:[^,]*,){'+n+'}':'';
  const both=(foe,s)=>pair.push(target+s+foe,foe+s+target);
  for(const [stride,kinds] of [[1,'[rq]'],[10,'[rq]'],[9,'[bq]'],[11,'[bq]']]){
    const skip=gap(stride-1);
    both(enemy+kinds+',',skip+'(?:,'+skip+')*');
  }
  for(const stride of [8,12,19,21])both(enemy+'n,',gap(stride-1));
  for(const stride of [9,11])pair.push(color==='w'?target+gap(stride-1)+enemy+'p,':enemy+'p,'+gap(stride-1)+target);
  return '.*(?:'+pair.join('|')+').*';
}

export function replySource() {
  // Exactly one moving-side slider, one moving-side king, and otherwise
  // only defender pieces or empty squares. Order need not be canonical.
  function material(c) {
    const other=c==='w'?'b':'w';
    const gaps='(?:[,#]|'+other+'[prnbqk],)*';
    return gaps+'(?:'+c+'k,'+gaps+c+'[rq],|'+c+'[rq],'+gaps+c+'k,)'+gaps;
  }
  return `function replyCapture(text, color) {
    return color == 'w' ? (text.matches('${material('w')}') && text.matches('${replies('w')}'))
                        : (text.matches('${material('b')}') && text.matches('${replies('b')}'));
  }`;
}
