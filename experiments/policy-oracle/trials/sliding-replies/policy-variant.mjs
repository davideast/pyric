import {sources as baseSources} from './compiler/sources.mjs';
import {link as baseLink} from './compiler/emit.mjs';
import {denseBase,denseLink,denseSources} from './protocol/dense.mjs';

export function sources(variant) {
  const base=denseBase(variant);
  return base?{...baseSources(base),...denseSources()}:baseSources(variant);
}

export function link(modules,variant) {
  const base=denseBase(variant);
  if (!base) return baseLink(modules,variant);
  const extra=Object.fromEntries(Object.keys(denseSources()).map(k=>[k,modules[k]]));
  const ordinary=Object.fromEntries(Object.entries(modules).filter(([k])=>!Object.hasOwn(extra,k)));
  return denseLink(baseLink(ordinary,base),extra);
}
