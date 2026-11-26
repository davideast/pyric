import {readFileSync} from 'node:fs';
const plan=JSON.parse(readFileSync(new URL('inputs.json',import.meta.url)));
export const namedIds=plan.cases.map(c=>c.id);
export function namedSample(id,writer,other){
  const c=plan.cases.find(row=>row.id===id);
  if(!c)throw new Error('Unknown named input '+id);
  const white=c.before.currentTurn==='host';
  return {before:{...structuredClone(c.before),host:white?writer:other,guest:white?other:writer},
    proposal:structuredClone(c.proposal)};
}
