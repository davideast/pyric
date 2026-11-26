// Once an interval straddles a square, the two halves each have only one
// outstanding bound. Every inspected cell uses the unchanged source board.
function rangeSource(name,cell) {
  function half(items,bound) {
    if(!items.length)return 'true';
    const [i,...rest]=items;
    const beyond=bound==='lo'?'lo >= '+i:'hi <= '+i;
    const inside=rest.length?'('+cell(i)+' && '+half(rest,bound)+')':cell(i);
    return '('+beyond+' || '+inside+')';
  }
  function range(items) {
    if(!items.length)return 'true';
    if(items.length===1) {
      const i=items[0];return '(lo >= '+i+' || hi <= '+i+' || '+cell(i)+')';
    }
    const mid=items.length>>1,i=items[mid],left=items.slice(0,mid),right=items.slice(mid+1);
    const interior=[cell(i),...(left.length?[half([...left].reverse(),'lo')]:[]),
      ...(right.length?[half(right,'hi')]:[])].join(' && ');
    return '(lo >= '+i+' ? '+range(right)+' : hi <= '+i+' ? '+range(left)+' : ('+interior+'))';
  }
  return 'function '+name+'(board, line, from, to) { let lo = from < to ? from : to; let hi = from < to ? to : from; return '+range([1,2,3,4,5,6])+'; }';
}

export function lineSources() {
  return {
    rankedClear:rangeSource('rankedClear',i=>"board['"+'abcdefgh'[i]+"' + line] == ''"),
    filedClear:rangeSource('filedClear',i=>"board[line + '"+(i+1)+"'] == ''"),
  };
}
