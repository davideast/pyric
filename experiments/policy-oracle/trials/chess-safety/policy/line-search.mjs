/** Precompute the eight possible ranks along each diagonal. The selected branch
 * reads one line only. Missing cells are walls, never board accesses. */
function diagonalLine(rising) {
  const low=rising?-7:0,high=rising?7:14,name=rising?'risingLine':'fallingLine';
  function choose(a,b) {
    if(a!==b) {
      const mid=Math.floor((a+b)/2);
      return '(key <= '+mid+' ? '+choose(a,mid)+' : '+choose(mid+1,b)+')';
    }
    const cells=Array.from({length:8},(_,y)=>{
      const x=rising?a+y:a-y;
      return x>=0&&x<8?'board.'+'abcdefgh'[x]+(y+1):"'#'";
    });
    return '['+cells.join(', ')+']';
  }
  return 'function '+name+'(board, key) { return '+choose(low,high)+'; }';
}

export function lineSources() {
  return {
    risingLine:diagonalLine(true),fallingLine:diagonalLine(false),
    clearBetween:`function clearBetween(cells, from, to) {
      let lo = from < to ? from : to;
      let hi = from < to ? to : from;
      let digits = ['0','1','2','3','4','5','6','7','8'];
      let pattern = '(?:[^,]*,){' + digits[lo + 1] + '},{' + digits[hi - lo - 1] + '}.*';
      return (cells.join(',') + ',').matches(pattern);
    }`,
  };
}

export const linePath="clearBetween((dx == dy ? risingLine(old.board, x - y) : fallingLine(old.board, x + y)), y, y + dy)";

export function compactRights(source,once) {
  const legacy="next.castling == keptRights(old.castling, piece, mv.from, mv.to)";
  // Unknown and noncanonical stored strings still take the original canonical-filter branch.
  return once(source,legacy,"next.castling == (old.castling.matches('K?Q?k?q?') ? dropRights(old.castling, piece, mv.from, mv.to) : keptRights(old.castling, piece, mv.from, mv.to))");
}

export const dropRights=`function dropRights(rights, piece, from, to) {
    let corners = {'a1':'Q','h1':'K','a8':'q','h8':'k'};
    let mask = '[' + (piece == 'wk' ? 'KQ' : piece == 'bk' ? 'kq' : '') + corners.get(from, 'x') + corners.get(to, 'x') + ']';
    return rights.replace(mask, '');
  }`;
