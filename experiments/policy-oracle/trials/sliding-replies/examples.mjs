// Extract the exact compiled modules exercised by the rook-pair policies.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sources} from './policy-variant.mjs';
const [variant]=process.argv.slice(2);
const {modules,source}=JSON.parse(readFileSync(0,'utf8'));
const policies=sources(variant);
const names=['sliderMaterialb','sliderEncodeb','slideCheckb','sliderrRankb','sliderrRank','sliderRankb','sliderorthogonalb','slideRecipeRank','slideFailurePattern','slideProject','slideModes','slideVector1','slideVector10','slideClassify','targetRayMask','targetRayCandidates','targetRayFinish','slideKingb','slideMayClaim','slideClaim']
  .filter(name=>Object.hasOwn(policies,name));
const pyric=[],rules=[];
for(const name of names) {
  const emitted=modules[name].replace(/^rules_version\s*=\s*'2\+modules';\s*export /,'').trim();
  assert.ok(emitted.startsWith('function '+name+'(') && source.includes(emitted),'missing emitted function '+name);
  pyric.push(policies[name]);rules.push(emitted);
}
assert.ok(names.some(n=>['sliderrRankb','sliderrRank','sliderRankb','sliderorthogonalb','slideProject','slideClassify','targetRayFinish'].includes(n)),'rook projection missing');
console.log(JSON.stringify({names,pyric:pyric.join('\n\n')+'\n',rules:rules.join('\n\n')+'\n'}));
