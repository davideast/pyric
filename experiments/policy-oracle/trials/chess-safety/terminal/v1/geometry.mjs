// Three pieces and a bare defending king. The opponent has no castling or pawn move.
export const squares=Array.from({length:64},(_,i)=>'abcdefgh'[i%8]+(1+Math.floor(i/8)));
const x=s=>s%8, y=s=>Math.floor(s/8);
export const touching=(a,b)=>Math.max(Math.abs(x(a)-x(b)),Math.abs(y(a)-y(b)))<=1;
export function sliderAttacks(slider, target, blocker, queen) {
  const dx=x(target)-x(slider),dy=y(target)-y(slider);
  if(dx!==0 && dy!==0 && (!queen || Math.abs(dx)!==Math.abs(dy))) return false;
  if(dx===0 && dy===0) return false;
  const step=Math.sign(dx)+8*Math.sign(dy);
  for(let s=slider+step;s!==target;s+=step) if(s===blocker) return false;
  return true;
}
const neighbors=squares.map((_,s)=>squares.flatMap((__,t)=>s!==t&&touching(s,t)?[t]:[]));
export function ending(slider,defender,attacker,queen) {
  for(const t of neighbors[defender]) {
    if(!touching(t,attacker) && (t===slider || !sliderAttacks(slider,t,attacker,queen))) return 'playing';
  }
  return sliderAttacks(slider,defender,attacker,queen)?'won':'draw';
}
export function groups() {
  const rows=[];
  for(const queen of [false,true])for(let s=0;s<64;s++)for(let d=0;d<64;d++){
    if(d===s)continue;
    const outcomes={won:[],draw:[]};
    for(let a=0;a<64;a++){
      if(a===s||touching(a,d))continue;
      const status=ending(s,d,a,queen);
      if(status!=='playing')outcomes[status].push(squares[a]);
    }
    for(const [status,attackers] of Object.entries(outcomes)){
      if(attackers.length)rows.push({queen,slider:squares[s],defender:squares[d],status,attackers});
    }
  }
  return rows;
}
