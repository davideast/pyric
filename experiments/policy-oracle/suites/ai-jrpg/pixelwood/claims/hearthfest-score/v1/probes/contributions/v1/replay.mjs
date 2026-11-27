import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const read = name => readFileSync(new URL(name,import.meta.url),'utf8');
const runtime = join(process.env.ORACLE_ROOT,'arcade/runtime');
const {compilePolicy} = await import(pathToFileURL(Bun.resolveSync('@pyric/rules/experimental/policy',runtime)));
const cases = JSON.parse(read('./cases.json'));
const catalogs = JSON.parse(read('./catalogs.json'));
const source = read('./award.policy');
function score(source) {
  const policy = compilePolicy(source);
  return Object.fromEntries(Object.entries(cases).map(([id,fixture]) => {
    const items = fixture.items ?? {};
    const {lines,benefits} = catalogs[fixture.cycle];
    const input = {lines:lines.map(line=>({...line,count:items[line.item] ?? 0})),benefits,counts:Object.values(items)};
    const award = policy.derive({before:{},input});
    const coverage = award.coverage?.valueOf();
    assert.equal(typeof coverage,'number');
    return [id,{...award,coverage}];
  }));
}
function mutate(from,to) {
  assert.equal(source.split(from).length,2);
  return score(source.replace(from,to));
}
const candidate = score(source);
const mutant = mutate('3*total.touched','0*total.touched');
const uncapped = mutate('extra >= 4 ? 2','extra >= 6 ? 3 : extra >= 4 ? 2');
assert.deepEqual(uncapped['pumpkin-8'],candidate['pumpkin-8']);
assert.notDeepEqual(uncapped['pumpkin-10'],candidate['pumpkin-10']);
console.log(JSON.stringify({candidate,mutant,diagnostics:{relaxedCap:uncapped['pumpkin-10']}},(_,value) =>
  typeof value === 'bigint' ? Number(value) : value));
