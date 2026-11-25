import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = resolve(process.argv[2]);
const { improves, verifyEntry, scorePath } = await import(pathToFileURL(join(src,'logic.ts')));
const rows = JSON.parse(readFileSync(new URL('cases.json',import.meta.url),'utf8')).cases;
const routes = JSON.parse(readFileSync(new URL('routes.json',import.meta.url),'utf8'));
const referenced = new Set();
for (const row of rows) {
  for (const [doc,key] of [[row.before,row.beforeRoute],[row.proposal,row.proposalRoute]]) {
    assert.ok(verifyEntry(doc,routes[key]).ok, row.id+' '+key);
    referenced.add(key);
  }
  assert.equal(scorePath(row.before.level,row.before.uid),row.path);
  const validIdentity = row.actor === row.before.uid && row.proposal.uid === row.before.uid;
  const validLevel = row.proposal.level === row.before.level;
  const candidateScore = validIdentity && validLevel && improves(row.before,row.proposal);
  assert.equal(row.expected,candidateScore ? 'ALLOW' : 'DENY',row.id);
}
assert.equal(referenced.size,Object.keys(routes).length);
console.log('Verified '+rows.length+' expected labels and '+referenced.size+' solution paths.');
