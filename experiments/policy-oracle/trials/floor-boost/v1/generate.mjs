// The game supplies geometry. The operator commits the standalone winner to the trusted step.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageDir, output] = process.argv.slice(2);
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8'));
const { compileFunction, compilePolicy } = await import(pathToFileURL(resolve(packageDir, manifest.exports['./experimental/policy'].import)));
const contact = JSON.parse(read('contact.json'));
const choose = compileFunction(read('floor-pick-landing.rules'));
const search = stones => stones.reduce((best, stone) => choose(best, stone, contact.sweep), null);
const winner = search(contact.stones);
assert.equal(winner.id, contact.observed.support);
assert.notEqual(search(contact.stones.filter(s => s.id !== winner.id))?.id, winner.id);
const platform = compilePolicy(read('floor-platform.policy'));
const input = {h:contact.h, landing:winner, restart:false, swept:true, buffered:contact.sweep.buffered, rescued:false};
const before = {remaining:contact.before.remaining, support:contact.before.support};
const derived = platform.derive({before, input});
const after = {remaining:contact.observed.remaining, support:contact.observed.support, landed:winner.id, event:'boost-compress'};
assert.ok(platform.judge({before, input, after}).ok);
assert.equal(platform.judge({before, input, after:{...after, remaining:0.060}}).requirement, 'compressionTimer');
const bindings = {'after.remaining':'request.resource.data.remaining',
  'before.remaining':'resource.data.before.remaining', 'input.landing':'resource.data.step.landing',
  'input.landing.kind':'resource.data.step.landing.kind', 'input.h':'resource.data.step.h',
  'input.restart':'resource.data.step.restart'};
const rows = platform.firestore(bindings, 'mixed');
assert.deepEqual(rows.filter(r => r.predicate).map(r => r.requirement), ['compressionTimer']);
const timer = rows.find(r => r.requirement === 'compressionTimer').predicate;
const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /steps/{id} {
      allow get: if request.auth != null && request.auth.uid in [resource.data.writer, resource.data.reader];
      allow update: if request.auth != null && request.auth.uid == resource.data.writer
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['remaining'])
        && (${timer});
    }
  }
}
`;
const recipe = {collection:'steps', before:{writer:'$actor', reader:'$reader', before:{remaining:before.remaining},
  step:{h:input.h, restart:input.restart, landing:winner}, remaining:before.remaining},
  cases:[{id:'boost-44ms', update:{remaining:0.044}}, {id:'boost-60ms', update:{remaining:0.060}}],
  positiveControl:'boost-44ms'};
mkdirSync(output, {recursive:true});
const writeJson = (name, value) => writeFileSync(join(output,name),JSON.stringify(value,(_,v)=>typeof v === 'bigint' ? Number(v):v,2)+'\n');
writeFileSync(join(output,'timer.rules'),rules);
writeJson('fixture.json',recipe);
writeJson('placement.json',{seed:contact.seed,tick:contact.tick,platformsExamined:contact.stones.length,winner,derived,requirements:rows});
