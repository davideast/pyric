import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rulesFor, testContext} from './catalog.mjs';
import {families} from './other.mjs';

// bun session-sdk.mjs /path/to/installed/project/package.json
const [project] = process.argv.slice(2);
assert.ok(project, 'Supply a project with pyric and @pyric/rules installed.');
const parent = pathToFileURL(resolve(project)).href;
const load = specifier => import(import.meta.resolve(specifier,parent));
const require = createRequire(parent);
const version = name => JSON.parse(readFileSync(require.resolve(name + '/package.json'))).version;
const {initializeSandbox} = await load('pyric/sandbox');
const {setRules} = await load('pyric/sandbox/firestore');
const {getFirestore,doc,collection,getDoc,getDocs,setDoc,query,where} = await load('pyric/firestore');
const sandbox = initializeSandbox(), rules = rulesFor('blocking');
setRules(sandbox,rules);
const ctx = testContext('blocking');
const clients = Object.fromEntries(['a','b'].map(role => [role,getFirestore(sandbox.withAuth({
  uid:ctx.uids[role],token:{email:ctx.emails[role]},
}))]));
clients.out = getFirestore(sandbox.withAuth(null));
const outcomes = {};
for (const step of families['session-access'](ctx)) {
  const db = clients[step.actor];
  try {
    if (step.op === 'query') {
      const constraints = step.filters.map(([field,op,value]) => where(field,op,value));
      const snapshot = await getDocs(query(collection(db,step.path),...constraints));
      outcomes[step.id] = {decision:'ALLOW',ids:snapshot.docs.map(snap=>snap.id).sort()};
    } else if (step.op === 'get') {
      const snapshot = await getDoc(doc(db,step.path));
      outcomes[step.id] = {decision:'ALLOW',id:snapshot.exists() ? snapshot.id : null};
    } else {
      assert.equal(step.op,'set');
      await setDoc(doc(db,step.path),step.data);
      outcomes[step.id] = {decision:'ALLOW'};
    }
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    outcomes[step.id] = {decision:'DENY',code:error.code};
  }
}
console.log(JSON.stringify({pyric:version('pyric'),rules:version('@pyric/rules'),
  sourceSha256:createHash('sha256').update(rules).digest('hex'),outcomes},null,2));
