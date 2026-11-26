import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scoreHosted} from './score-hosted.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const trial=resolve(here,'..'),ref=join(trial,'reference');
const [policies=join(trial,'policies'),rules=join(trial,'bundle/artifacts'),holdout]=process.argv.slice(2);
const board=resolve(policies,'chess.mjs'),match=resolve(policies,'chess-match.mjs');
const corpora=[join(ref,'public.json.gz'),...(holdout?[resolve(holdout)]:[])];
const suites={};
for(const [name,script,args] of [
  ['board','score.mjs',[board,...corpora]],['metadata','score-metadata.mjs',[board,match,...corpora]],
]){
  const child=spawnSync(process.execPath,[join(ref,script),...args],{encoding:'utf8'});
  if(child.error) throw child.error;
  if(child.stderr) process.stderr.write(child.stderr);
  assert.ok(child.stdout,name+' replay produced no report');
  suites[name]=JSON.parse(child.stdout);
  if(child.status!==0) process.exitCode=1;
}
const simulator=resolve(here,'../../../arcade/runtime/node_modules/@pyric/rules');
const profiles=await scoreHosted({rulesDirectory:resolve(rules),simulator,policiesDirectory:resolve(policies)});
suites.hosted=profiles.map(p=>({...p,rows:p.rows.length}));
if(profiles.some(p=>p.mismatches.length)) process.exitCode=1;
console.log(JSON.stringify(suites,null,2));
