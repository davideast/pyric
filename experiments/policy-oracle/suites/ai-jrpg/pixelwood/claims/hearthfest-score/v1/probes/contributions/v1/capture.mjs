import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [checkout] = process.argv.slice(2);
const revision = 'b3bed5e36acaa7bfc47a600e86e015fb84b1ac70';
const path = name => new URL(name,import.meta.url);
const cases = JSON.parse(readFileSync(path('./cases.json')));
const dir = mkdtempSync(join(tmpdir(),'hearthfest-native-'));
const sources = {}, files = [];
try {
  function stage(name,bytes) {
    writeFileSync(join(dir,name),bytes);
    files.push(name);
  }
  stage('package.json','{"type":"module"}');
  for (const name of ['hearthfest.js','clock.js','registry.js']) {
    const bytes = execFileSync('git',['-C',checkout,'show',revision+':app/'+name]);
    sources['app/'+name] = createHash('sha256').update(bytes).digest('hex');
    stage(name,bytes);
  }
  const {callFor,scoreFor,benefitsFor,TIERS} = await import(pathToFileURL(join(dir,'hearthfest.js')));
  const catalogs = {}, results = {};
  for (const [id,{cycle,items}] of Object.entries(cases)) {
    const call = callFor(cycle);
    function benefit(tier) {
      const b = benefitsFor(cycle,tier);
      return b ? {label:b.label,gold:b.grant.gold ?? 0,items:b.grant.items ?? {}} : null;
    }
    catalogs[cycle] = {lines:call.lines.map(({item,qty})=>({item,qty})),
      benefits:Object.fromEntries(['none',...TIERS].map(tier=>[tier,benefit(tier)]))};
    const score = scoreFor(items,call);
    results[id] = {...score,benefit:benefit(score.tier)};
  }
  for (const [name,value] of [['catalogs.json',catalogs],['evidence/score-for.json',{revision,sources,results}]]) {
    const data = JSON.stringify(value,null,2)+'\n';
    if (process.argv.includes('--capture')) writeFileSync(path(name),data,{flag:'wx'});
    else assert.equal(readFileSync(path(name),'utf8'),data);
  }
} finally {
  for (const name of files) unlinkSync(join(dir,name));
  rmdirSync(dir);
}
