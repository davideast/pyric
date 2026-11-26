/**
 * Flatten the eight board ranks with two wall tokens between ranks. A knight
 * can jump two files, so a single wall would allow an edge to wrap around.
 * Cells end in commas. An empty cell is ',' and a wall is '#,'.
 */
const files='abcdefgh';
const token='(?:[^,]*,)';
const skip=n=>n===0?'':token+'{'+n+'}';
const either = xs => '(?:'+xs.join('|')+')';

export function attackPattern(color) {
  const king=color+'k,';
  const other=color==='w'?'b':'w';
  const attacks=[];
  function eitherOrder(foe,gap) {
    attacks.push(king+gap+foe,foe+gap+king);
  }
  // At stride S, S-1 tokens lie between adjacent cells on this ray.
  // Every additional step requires an empty intervening ray cell.
  for (const [stride,pieces] of [[1,'[rq]'],[10,'[rq]'],[9,'[bq]'],[11,'[bq]']]) {
    const gap=skip(stride-1);
    eitherOrder(other+pieces+',',gap+'(?:,'+gap+')*');
  }
  for (const stride of [8,12,19,21]) eitherOrder(other+'n,',skip(stride-1));
  for (const stride of [1,9,10,11]) eitherOrder(other+'k,',skip(stride-1));
  for (const stride of [9,11]) {
    const foe=other+'p,';
    attacks.push(color==='w' ? king+skip(stride-1)+foe : foe+skip(stride-1)+king);
  }
  return '.*'+either(attacks)+'.*';
}

export function packedSources() {
  const cells=[];
  for(const rank of '12345678') {
    for(const f of files) {
      const square=f+rank;
      let value='board.'+square;
      // Castle geometry assures these two intervening cells are empty on the
      // source board. Mark them as additional target kings. If one target
      // blocks a ray to another, the nearer target is already attacked.
      if((rank==='1'||rank==='8') && 'cdfg'.includes(f)) {
        const color=rank==='1'?'w':'b',side='fg'.includes(f)?'short':'long';
        value="route == '"+color+side+"' ? '"+color+"k' : "+value;
      }
      cells.push(value);
    }
    cells.push("'#,#'");
  }
  return {
    packBoard:`function packBoard(board, route) { return [${cells.join(', ')}].join(',') + ','; }`,
    packedSafe:`function packedSafe(text, color) {
    return color == 'w' ? text.matches('.*wk,.*') && !text.matches('${attackPattern('w')}')
      : text.matches('.*bk,.*') && !text.matches('${attackPattern('b')}');
  }`,
  };
}

export function packedGuard() {
  return `function safeTransition(old, next, color, kingMove, castle, xTo, yTo) {
    let route = castle ? color + (xTo > 4 ? 'short' : 'long') : '';
    return packedSafe(packBoard(castle ? old.board : next.board, route), color);
  }`;
}

export function packedPredict(compiled, {resource:old,data:next}) {
  const color=old.currentTurn==='host'?'w':'b';
  const {from,to}=next.lastMove;
  const castle=old.board[from]===color+'k' && from[1]===to[1] && Math.abs(files.indexOf(from[0])-files.indexOf(to[0]))===2;
  const route=castle?color+(to[0]==='g'?'short':'long'):'';
  return compiled.packedSafe(compiled.packBoard(castle?old.board:next.board,route),color);
}
