import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest, sha } from '../../../arcade/corpus.mjs';
import { startJournal, errorDetails } from '../../../arcade/live/controller/archive.mjs';
import { clientsFor, lite } from '../../../arcade/live/controller/clients.mjs';
import * as firebaseApp from '../../../arcade/live/controller/chess-sdk.mjs';
import { counterPropagation } from '../../../arcade/live/controller/counter-controls.mjs';
import { withRelease } from '../../../arcade/live/controller/release.mjs';
import { protocol } from './cases.mjs';
import { specialCases } from '../bundle/special-cases.mjs';

const [mode, archive, bundle, digest, gameBuild, enginePath] = process.argv.slice(2);
assert.ok(['stock','compatibility','stronger','referee'].includes(mode));
const source = readFileSync(bundle,'utf8');
assert.equal(sha(source), digest);
assert.equal(mode === 'stock',digest === manifest.files['v1/rules/stock.rules']);
const native = await import(pathToFileURL(resolve(gameBuild,'native.mjs')));
const runId = randomUUID();
const journal = startJournal(archive,runId);
console.log('Private run', journal.directory, mode, digest);
let stopping = false;
const stop = () => {stopping = true;};
process.on('SIGINT',stop); process.on('SIGTERM',stop);
const checkStop = () => assert.ok(!stopping,'interrupted');
const clients = clientsFor(runId,journal);
let writer, guest, reader, config, unauthedApp, receipt;
try {
  try {
    receipt = await withRelease({runId,journal,source,digest,checkStop,
      async setupClients(settings) {
        config = settings;
        writer = await clients.add('host',config); guest = await clients.add('guest',config);
        reader = await clients.add('observer',config);
        unauthedApp = firebaseApp.initializeApp(config,runId + '-signed-out');
      },
      async checkPropagation(phase,proof) {
        // A fresh SDK request can still see the preceding rules immediately after two successful control rounds.
        if (phase === 'open') await delay(Math.max(0, Date.parse(proof.releaseUpdateTime) + 65000 - Date.now()));
        return counterPropagation({phase,proof,runId,writer,reader,journal,checkStop});
      },
      async capture(verify) {
        const unauth = lite.getFirestore(unauthedApp,manifest.target.database);
        const args = {runId,writer,guest,reader,verify,journal,native,mode,unauth};
        const rows = [...await protocol(args), ...await specialCases(args)];
        let browser;
        if (mode === 'referee') {
          const {play} = await import('./browser.mjs');
          browser = await play({...args,config,gameBuild,enginePath});
        }
        return journal.retain({runId,mode,rulesSha256:digest,target:manifest.target,rows,browser});
      }});
  } finally { if (unauthedApp) await firebaseApp.deleteApp(unauthedApp); await clients.close(); }
  journal.complete({mode,runId,rulesSha256:digest,receipt});
  console.log('Completed',mode,receipt);
} catch(e) {
  journal.event('failure',errorDetails(e));
  console.error('Capture failed',e.code || e.name, String(e.message).slice(0,220), String(e.stack).split('\n').filter(s => s.includes('/chess/') || s.includes('controller/')).slice(0,3).join('\n'));
  process.exitCode = 1;
} finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
