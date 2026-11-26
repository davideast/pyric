import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {dbName} from '../../../arcade/live/control.mjs';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {manifest} from '../../../arcade/corpus.mjs';
import {wireFields} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {startJournal,errorDetails} from '../../../arcade/live/controller/archive.mjs';
import {initializeApp,deleteApp} from '../../../arcade/live/controller/chess-sdk.mjs';
import {clientsFor,createDocument,readDocument,lite} from '../../../arcade/live/controller/clients.mjs';
import {counterPropagation} from '../../../arcade/live/controller/counter-controls.mjs';
import {withRelease} from '../../../arcade/live/controller/release.mjs';
import {decision,snapshot} from '../../chess/live/snapshots.mjs';
import {transition} from '../../chess/verify/document.mjs';
import * as defaults from './fixtures.mjs';
import {afterObservation} from './evidence.mjs';

export async function capture(args, fixtures = defaults) {
  const [mode,archive,bundle,rulesSha256] = args;
  const {checkBundle,profile} = fixtures;
  const source = readFileSync(bundle,'utf8');
  checkBundle(mode,source,rulesSha256);
  const spec = profile(mode);
  async function takeSnapshot(reader,path) {
    if(mode!=='ordered-errors') return snapshot(reader,path);
    const snap=await lite.getDoc(lite.doc(reader.lite,path));
    const wire=await readDocument(path);
    assert.equal(wire.name,dbName+'/documents/'+path);
    assert.ok(snap.exists());
    assert.deepEqual(wire.fields,wireFields(snap.data()));
    return {path,data:snap.data(),version:wire.updateTime,created:wire.createTime};
  }
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
        for (const c of spec.cases) {
          checkStop();
          const path = spec.collection+'/'+runId+'-'+c.id, proof = await verify();
          const actor = writer.identity.uid, readerUid = reader.identity.uid;
          assert.equal(writer.auth.currentUser.uid,actor);
          assert.equal(reader.auth.currentUser.uid,readerUid);
          const s = spec.sample(c,actor,guest.identity.uid);
          const fields=wireFields(s.before);
          if (mode!=='ordered-errors') fields.createdAt={timestampValue:'2026-01-01T00:00:00Z'};
          await createDocument(path,fields);
          const before = await takeSnapshot(reader,path);
          assert.deepEqual(before.data,s.before);
          const observed = await decision(() => lite.updateDoc(lite.doc(writer.lite,path),s.proposal));
          const after = await takeSnapshot(reader,path);
          const row = {id:c.id,actor,reader:readerUid,probe:spec.probe(c),
            expected:c.expected,observed,before:[before],after:[after],
            submitted:[{op:'update',path,data:s.proposal}],proof,end:await verify()};
          journal.event('chess-attempt',row);
          transition(before,after,afterObservation(spec,c,s,observed),c.id);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await capture(process.argv.slice(2));
