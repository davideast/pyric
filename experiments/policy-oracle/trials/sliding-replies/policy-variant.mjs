import {sources as baseSources} from './compiler/sources.mjs';
import {link as baseLink} from './compiler/emit.mjs';
import {denseBase,denseLink,denseSources} from './protocol/dense.mjs';
import {targetSources,targetLink} from './protocol/target-rays.mjs';
import {fileCheckSources,skipImpossibleSecondRook} from './protocol/file-check.mjs';
import {lean} from './protocol/lean.mjs';
import {linkSharedStatus} from './protocol/shared-status.mjs';

function options(variant) {
  const leanProtocol=variant.endsWith('-lean');
  if(leanProtocol) variant=variant.slice(0,-5);
  const cut=variant.endsWith('-filecut');
  if(cut) variant=variant.slice(0,-8);
  const once=variant.endsWith('-once');
  const inner=once?variant.slice(0,-5):variant;
  const boxed=inner.endsWith('-boxed');
  const base=boxed?inner.slice(0,-6):denseBase(inner);
  const middle=base??inner;
  // The earlier -targets experiment omitted the projection exports. Its saved
  // evaluation errors are retained for the revision-history replay.
  const target=['-targets','-mask'].find(suffix=>middle.endsWith(suffix));
  return {base:target?middle.slice(0,-target.length):middle,dense:base!==null,once,leanProtocol,target,boxed,cut};
}
export function sources(variant) {
  const {base,dense,target,boxed,cut}=options(variant);
  const src=target==='-mask'?targetSources():baseSources(base);
  return {...src,...(dense?denseSources(boxed):{}),...(cut?fileCheckSources:{})};
}

export function link(modules,variant) {
  const {base,dense,once,leanProtocol,target,boxed,cut}=options(variant);
  let source;
  if(dense) {
    const extra=Object.fromEntries(Object.keys(denseSources(boxed)).map(k=>[k,modules[k]]));
    const ordinary=Object.fromEntries(Object.entries(modules).filter(([k])=>!Object.hasOwn(extra,k)));
    source=denseLink(baseLink(ordinary,base),extra,boxed);
  } else source=baseLink(modules,base);
  if(target) source=targetLink(source);
  if(once) source=linkSharedStatus(source,dense);
  if(cut) source=skipImpossibleSecondRook(source);
  return leanProtocol?lean(source):source;
}
