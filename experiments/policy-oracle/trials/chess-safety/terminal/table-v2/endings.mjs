import {touching,sliderAttacks} from '../v1/geometry.mjs';
export const pieces=['r','q','b','n'];
const neighbors=Array.from({length:64},(_,d)=>Array.from({length:64},(_,s)=>s).filter(s=>d!==s&&touching(s,d)));
function attacks(piece,s,target,a) {
  if(piece==='r'||piece==='q')return sliderAttacks(s,target,a,piece==='q');
  const dx=Math.abs(s%8-target%8),dy=Math.abs((s>>3)-(target>>3));
  if(piece==='n')return dx*dy===2;
  return dx===dy&&sliderAttacks(s,target,a,true);
}
export function verdict(piece,s,d,a) {
  for(const to of neighbors[d]){
    if(!touching(a,to) && (to===s || !attacks(piece,s,to,a)))return 'playing';
  }
  return attacks(piece,s,d,a)?'won':'draw';
}
export function compress() {
  const dictionary=[], index=new Map(), header=[];
  const padded=s=>s%8+(s>>3)*10;
  for(const piece of pieces)for(let s=0;s<64;s++){
    for(let pd=0;pd<80;pd++){
      const d=(pd%10)+Math.floor(pd/10)*8;
      const row=Array(80).fill('p');
      if(pd%10<8 && d!==s){
        for(let a=0;a<64;a++)if(a!==s&&!touching(a,d))row[padded(a)]=verdict(piece,s,d,a)[0];
      }
      const str=row.join('');
      if(!index.has(str)){index.set(str,dictionary.length);dictionary.push(str);}
      header.push(index.get(str));
    }
  }
  const width=String(dictionary.length-1).length;
  return {header:header.map(n=>String(n).padStart(width,'0')).join(''),data:dictionary.join(''),entries:dictionary.length,width};
}

export function tile(piece,start,count) {
  const rows=[],lookup=new Map(),heads=[];
  for(let s=start;s<start+count;s++)for(let pd=0;pd<80;pd++){
    const d=pd%10+((pd/10)|0)*8;
    const row=Array(80).fill('p');
    if(pd%10<8 && d!==s)for(let a=0;a<64;a++){
      if(a!==s && !touching(a,d))row[a%8+(a>>3)*10]=verdict(piece,s,d,a)[0];
    }
    const key=row.join('');
    if(!lookup.has(key)){lookup.set(key,rows.length);rows.push(key);}
    heads.push(lookup.get(key));
  }
  const width=String(rows.length-1).length;
  return {header:heads.map(n=>String(n).padStart(width,'0')).join(''),data:rows.join(''),width};
}
