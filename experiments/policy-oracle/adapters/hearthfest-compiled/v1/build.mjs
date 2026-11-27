import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compileAward} from './compile.mjs';
import {sourcePath as stockPath,sourceDigest as stockDigest} from '../../invite-profile/v1/fixture.mjs';

export const nativePath = 'suites/ai-jrpg/pixelwood/claims/hearthfest-score/v1/probes/contributions/v1';
export const artifactPath = 'suites/ai-jrpg/pixelwood/claims/hearthfest-compiled-award/v1/probes/award-lifecycle/v1/generated.rules';
export async function build(root) {
  const read = path => readFileSync(join(root,path),'utf8');
  const stock = read(stockPath);
  assert.equal(createHash('sha256').update(stock).digest('hex'),stockDigest);
  const catalog = JSON.parse(read(nativePath+'/catalogs.json'))[7];
  const helpers = await compileAward(root,read(nativePath+'/award.policy'),catalog,7);
  const header = 'match /hearthfest/{cycle}/awards/{pid} {';
  const allow = 'allow create, update: if request.auth != null;';
  const block = header+'\n      allow read: if request.auth != null;\n      '+allow;
  assert.equal(stock.split(block).length,2);
  return stock.replace(block,()=>block.replace(allow,helpers+'\n      allow create, update: if request.auth != null && validAward();'));
}
