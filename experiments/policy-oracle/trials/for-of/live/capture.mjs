import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {manifest} from '../../../arcade/corpus.mjs';
import {wireFields} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {startJournal,errorDetails} from '../../../arcade/live/controller/archive.mjs';
import {initializeApp,deleteApp} from '../../../arcade/live/controller/chess-sdk.mjs';
import {clientsFor,createDocument,lite} from '../../../arcade/live/controller/clients.mjs';
import {counterPropagation} from '../../../arcade/live/controller/counter-controls.mjs';
import {withRelease} from '../../../arcade/live/controller/release.mjs';
import {decision,snapshot} from '../../chess/live/snapshots.mjs';
import {transition} from '../../chess/verify/document.mjs';
import {cases,checkBundle,sample} from './fixtures.mjs';

const [mode,archive,bundle,rulesSha256] = process.argv.slice(2);
const source = readFileSync(bundle,'utf8');
checkBundle(mode,source,rulesSha256);
const runId = randomUUID(), journal = startJournal(archive,runId);
console.log('Private run',runId,mode,rulesSha256);
const clients = clientsFor(runId,journal);
let stopped = false, writer, guest, reader, anonymousApp;
const stop = () => {stopped = true;};
const checkStop = () => assert.ok(!stopped,'interrupted');
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
  const receipt = await withRelease({runId,journal,source,digest:rulesSha256,checkStop,
    async setupClients(config) {
      writer = await clients.add('host',config);
      guest = await clients.add('guest',config);
      reader = await clients.add('observer',config);
      anonymousApp = initializeApp(config,runId+'-signed-out');
    },
    async checkPropagation(phase,proof) {
      if(phase === 'open') await wait(Math.max(0,Date.parse(proof.releaseUpdateTime)+65000-Date.now()));
      return counterPropagation({phase,proof,runId,writer,reader,journal,checkStop});
    },
    async capture(verify) {
      const rows = [];
      const signedOut = lite.getFirestore(anonymousApp,manifest.target.database);
      const controlPath = 'chess/'+runId;
      const control = await decision(() => lite.getDoc(lite.doc(signedOut,controlPath)));
      assert.equal(control,'DENY');
      journal.event('unauthenticated-read',{path:controlPath,observed:control});
      for (const c of cases) {
        checkStop();
        const path = controlPath+'-'+c.id, proof = await verify();
        const actor = writer.identity.uid, readerUid = reader.identity.uid;
        assert.equal(writer.auth.currentUser.uid,actor);
        assert.equal(reader.auth.currentUser.uid,readerUid);
        const s = sample(c,actor,guest.identity.uid);
        await createDocument(path,{...wireFields(s.before),createdAt:{timestampValue:'2026-01-01T00:00:00Z'}});
        const before = await snapshot(reader,path);
        assert.deepEqual(before.data,s.before);
        const observed = await decision(() => lite.updateDoc(lite.doc(writer.lite,path),s.proposal));
        const after = await snapshot(reader,path);
        const row = {id:c.id,actor,reader:readerUid,probe:{fen:c.fen,uci:c.uci},
          expected:c.expected,observed,before:[before],after:[after],
          submitted:[{op:'update',path,data:s.proposal}],proof,end:await verify()};
        journal.event('chess-attempt',row);
        assert.equal(observed,c.expected,c.id);
        transition(before,after,s.after,c.id);
        rows.push(row);
      }
      return journal.retain({runId,mode,rulesSha256,target:manifest.target,rows});
    },
  });
  journal.complete({mode,runId,rulesSha256,receipt});
  console.log('Qualified',mode,receipt);
} catch(error) {
  journal.event('failure',errorDetails(error));
  console.error('Incomplete capture',runId,error.code??error.name,String(error.message).split('\n')[0].slice(0,160));
  process.exitCode = 1;
} finally {
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
  if(anonymousApp) await deleteApp(anonymousApp);
  await clients.close();
}
