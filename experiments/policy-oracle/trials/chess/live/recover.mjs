import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {manifest} from '../../../arcade/corpus.mjs';
import {api,dbUrl,currentRelease,switchRelease,preflight,releaseLock} from '../../../arcade/live/control.mjs';
import {startJournal,privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {clientsFor} from '../../../arcade/live/controller/clients.mjs';
import {counterPropagation} from '../../../arcade/live/controller/counter-controls.mjs';

const [archive,runId] = process.argv.slice(2);
assert.match(runId,/^[a-f0-9-]{36}$/);
const original = join(privateArchive(archive),runId);
const record = kind => {
  const matches = readdirSync(original).filter(f => /^\d+-/.test(f) && f.endsWith('-'+kind+'.json'));
  assert.equal(matches.length,1);
  return JSON.parse(readFileSync(join(original,matches[0]),'utf8')).data;
};
const old = record('acquired');
const activation = record('activate');
assert.equal(old.lockRunId,runId);
assert.equal(old.databaseUid,manifest.target.uid);
assert.equal(activation.previous,manifest.target.closedRuleset);
async function owner() {
  assert.equal((await api(dbUrl)).uid,old.databaseUid);
  const lock = await api(dbUrl + '/documents/oracleLocks/arcade-counter');
  assert.equal(lock.fields.runId.stringValue,runId);
  assert.equal(lock.updateTime,old.lockVersion);
}
const journal = startJournal(archive,randomUUID());
await owner();
const current = await currentRelease();
assert.ok([activation.candidate,activation.previous].includes(current.rulesetName),'third-party release');
journal.event('owned-recovery',{runId,current,old,activation});
if (current.rulesetName === activation.candidate) await switchRelease(activation.previous);
const {config,release} = await preflight();
const clients = clientsFor(randomUUID(),journal);
try {
  const writer = await clients.add('recovery-writer',config), reader = await clients.add('recovery-reader',config);
  await counterPropagation({phase:'restored-closed',proof:{...old,releaseUpdateTime:release.updateTime},runId,writer,reader,journal,checkStop() {}});
  await owner();
  assert.equal((await currentRelease()).rulesetName,activation.previous);
  await releaseLock(old.lockVersion);
  journal.event('released',{runId,version:old.lockVersion});
} finally { await clients.close(); }
journal.complete({mode:'recovery',restored:activation.previous,runId});
console.log('Verified closed database and released original lease',runId,journal.directory);
