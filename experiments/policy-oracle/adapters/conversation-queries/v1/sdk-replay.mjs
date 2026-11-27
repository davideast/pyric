import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {rulesFor} from '../../ai-jrpg-campaign/v1/catalog.mjs';
import {steps} from './fixture.mjs';

// Run the recorded requests using the actual document IDs and UIDs in a fresh Pyric SDK sandbox.
const [project,receipt] = process.argv.slice(2);
const load = name=>import(import.meta.resolve(name,pathToFileURL(resolve(project)).href));
const {initializeSandbox} = await load('pyric/sandbox');
const {setRules} = await load('pyric/sandbox/firestore');
const {collection,doc,getDocs,getFirestore,query,setDoc,updateDoc,where} = await load('pyric/firestore');
const {ctx,rows} = JSON.parse(readFileSync(receipt));
const sandbox = initializeSandbox();
setRules(sandbox,rulesFor('genkit'));
const clients = Object.fromEntries(Object.entries(ctx.uids).map(([role,uid])=>
  [role,getFirestore(sandbox.withAuth({uid}))]));
const results = {};
for (const step of steps(ctx)) {
  const db = clients[step.actor];
  try {
    if (step.op === 'query') {
      const snap = await getDocs(query(collection(db,step.path),...step.filters.map(args=>where(...args))));
      results[step.id] = {verdict:'ALLOW',ids:snap.docs.map(doc=>doc.id).sort()};
    } else {
      const write = step.op === 'set' ? setDoc : updateDoc;
      await write(doc(db,step.path),step.data);
      results[step.id] = {verdict:'ALLOW'};
    }
  } catch (error) {
    assert.equal(error.code,'permission-denied',String(error));
    results[step.id] = {verdict:'DENY'};
  }
}
const misses = [];
for (const [id,actual] of Object.entries(results)) {
  const {step,response} = rows[id];
  const expected = {verdict:response.verdict};
  if (step.op === 'query' && response.verdict === 'ALLOW') {
    expected.ids = response.value.map(doc=>doc.id).sort();
  }
  if (!isDeepStrictEqual(actual,expected)) misses.push({id,expected,actual});
}
console.log(JSON.stringify({results,misses},null,2));
if (misses.length) process.exitCode = 1;
