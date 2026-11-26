import assert from 'node:assert/strict';
import * as base from '../../mobility/combined.mjs';
import {sources} from './policy.mjs';

export function compile(api,variant,opts){
  if(!variant.startsWith('pawn-'))return base.compile(api,variant,opts);
  const out=base.compile(api,variant.slice(5),opts);
  for(const [name,source] of Object.entries(sources())){
    const fn=api(source);
    if(opts.mode!=='standalone')out.modules[name]=fn.firestoreModule();
  }
  return out;
}
export async function link(modules,resolveModules,{variant}){
  if(!variant.startsWith('pawn-'))return base.link(modules,resolveModules,{variant});
  const names=Object.keys(sources());
  const original=Object.fromEntries(Object.entries(modules).filter(([k])=>!names.includes(k)));
  const rules=await base.link(original,resolveModules,{variant:variant.slice(5)});
  // This conjunct is evaluated only when the parent has an otherwise admissible claimed terminal state.
  const anchor='!hasKingReply(text, defender)';
  assert.equal(rules.split(anchor).length,2,'expected one terminal claim deciding king mobility');
  const gate=anchor+" && (defender == 'w' ? !pawnReplyw(text) : !pawnReplyb(text))";
  const full=rules.replace(anchor,gate).replace("rules_version = '2';","rules_version = '2+modules';\n"+
    names.map(n=>`import { ${n} } from './${n}';`).join('\n'));
  const resolver=resolveModules(full,{modules:Object.fromEntries(names.map(n=>['./'+n,modules[n]])),sourceFile:'pawn-reply.modules.rules'});
  assert.ok(resolver.success,resolver.error?.message);
  const out=resolver.data.resolved;
  assert.ok(out.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return out.slice(0,out.lastIndexOf('// @pyric-source-map: '));
}
