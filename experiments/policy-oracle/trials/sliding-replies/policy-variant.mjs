import {sources as baseSources} from './compiler/sources.mjs';
import {link as baseLink} from './compiler/emit.mjs';
import {denseBase,denseLink,denseSources} from './protocol/dense.mjs';
import {targetSources,targetLink} from './protocol/target-rays.mjs';
import {fileCheckSources,skipImpossibleSecondRook} from './protocol/file-check.mjs';
import {lean} from './protocol/lean.mjs';
import {linkSharedStatus} from './protocol/shared-status.mjs';

import {twoKnightSources,linkTwoKnights} from './compiler/two-knights.mjs';

import {lonePawnSources,linkLonePawn} from './compiler/lone-pawn.mjs';

import {mixedSliderSources,linkMixedSlider} from './compiler/mixed-slider.mjs';

function options(variant) {
  const mixedSlider=variant==='all-mixed-replies-v20-dense3-lean';
  if(mixedSlider) variant='all-lone-pawn-v19-dense3-lean';
  const lonePawn=variant==='all-lone-pawn-v19-dense3-lean';
  if(lonePawn) variant='all-two-knights-v18-dense3-lean';
  const twoKnights=variant==='all-two-knights-v18-dense3-lean';
  if(twoKnights) variant='all-mixed-sliders-v17-dense3-lean';
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
  return {mixedSlider,lonePawn,twoKnights,base:target?middle.slice(0,-target.length):middle,dense:base!==null,once,leanProtocol,target,boxed,cut};
}
export function sources(variant) {
  const {mixedSlider,lonePawn,twoKnights,base,dense,target,boxed,cut}=options(variant);
  const src=target==='-mask'?targetSources():baseSources(base);
  return {...src,...(mixedSlider?mixedSliderSources:{}),...(lonePawn?lonePawnSources:{}),...(twoKnights?twoKnightSources:{}),...(dense?denseSources(boxed):{}),...(cut?fileCheckSources:{})};
}

export function link(modules,variant) {
  const {mixedSlider,lonePawn,twoKnights,base,dense,once,leanProtocol,target,boxed,cut}=options(variant);
  let source;
  if(dense) {
    const extra=Object.fromEntries(Object.keys(denseSources(boxed)).map(k=>[k,modules[k]]));
    const ordinary=Object.fromEntries(Object.entries(modules).filter(([k])=>!Object.hasOwn(extra,k)));
    source=denseLink(baseLink(ordinary,base),extra,boxed);
  } else source=baseLink(modules,base);
  if(twoKnights) source=linkTwoKnights(source);
  if(lonePawn) source=linkLonePawn(source);
  if(mixedSlider) source=linkMixedSlider(source);
  if(target) source=targetLink(source);
  if(once) source=linkSharedStatus(source,dense);
  if(cut) source=skipImpossibleSecondRook(source);
  return leanProtocol?lean(source):source;
}
