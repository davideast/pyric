import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureAttempt } from '../../../adapters/arcade-sdk/v1/capture.mjs';
import { databasePath, normalizeEvidence, releaseName, stockSha256 } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { read, sha } from '../../corpus.mjs';
import { errorDetails, immutable, jsonBytes, privateArchive, startJournal } from './archive.mjs';
import { stockProbes } from './probes.mjs';

const runPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function capture(archive, probes) {
  const { clientsFor, createDocument, getIdTokenResult, readDocument, sdk, SDK_VERSION } = await import('./clients.mjs');
  const { withRelease } = await import('./release.mjs');
  const { counterPropagation } = await import('./counter-controls.mjs');
  const runId = randomUUID();
  const journal = startJournal(archive, runId);
  console.log('Stock capture journal', journal.directory);
  const clients = clientsFor(runId, journal);
  let stopping = false;
  const interrupt = () => { stopping = true; };
  const checkStop = () => assert.ok(!stopping, 'capture interrupted');
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  let writer, reader, otherWriter;
  try {
    let receipts;
    try {
      receipts = await withRelease({
        runId, journal, source: read('v1/rules/stock.rules'), digest: stockSha256, checkStop,
        async setupClients(config) {
          writer = await clients.add('writer', config);
          reader = await clients.add('reader', config);
          otherWriter = await clients.add('second-sokoban-writer', config);
        },
        async checkPropagation(phase, proof) {
          return counterPropagation({ phase, proof, runId, writer, reader, journal, checkStop });
        },
        async capture(verify) {
          const archives = {};
          for (const { game, probe, url, inputDigest } of probes) {
            const rows = {};
            for (const [index, caseId] of probe.cases.entries()) {
              checkStop();
              journal.event('case-start', { game, caseId });
              rows[caseId] = await captureAttempt(url, caseId, {
                runId, readerAuth: reader.auth, writerAuth: game === 'sokoban' && index > 0 ? otherWriter.auth : writer.auth,
                sdk, sdkVersion: SDK_VERSION, getIdTokenResult, readDocument, createDocument,
                async verifyStock(request) {
                  assert.equal(request.stockSha256, stockSha256);
                  assert.equal(request.releaseName, releaseName);
                  assert.equal(request.databasePath, databasePath);
                  assert.equal(request.runId, runId);
                  return { ...await verify(), phase: request.phase };
                },
                journal: row => journal.event('attempt', row),
              });
              console.log(game, caseId, rows[caseId].decision);
            }
            const results = normalizeEvidence(probe, { rows });
            const digest = journal.retain({ rows });
            archives[game] = { digest, results, inputDigest };
            journal.event('probe-complete', { game, ...archives[game] });
          }
          return archives;
        },
      });
    } finally {
      await clients.close();
    }
    journal.complete({ runId, releaseName, stockSha256, receipts });
    console.log('Completed stock capture', runId);
  } catch (error) {
    journal.event('failure', errorDetails(error));
    throw error;
  } finally {
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
}

function importReviewed(archive, runId, probes) {
  assert.match(runId, runPattern);
  const completed = JSON.parse(readFileSync(join(archive, runId, 'completed.json')));
  assert.equal(completed.runId, runId);
  assert.equal(completed.releaseName, releaseName);
  assert.equal(completed.stockSha256, stockSha256);
  assert.deepEqual(Object.keys(completed.receipts).sort(), probes.map(p => p.game).sort());
  const files = probes.map(({ game, directory, inputDigest, probe }) => {
    const { digest, results, inputDigest: recordedInput } = completed.receipts[game];
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(recordedInput, inputDigest);
    const bytes = readFileSync(join(archive, digest + '.json'));
    assert.equal(sha(bytes), digest);
    const receipt = JSON.parse(bytes);
    assert.deepEqual(normalizeEvidence(probe, receipt), results);
    assert.equal(Object.values(receipt.rows)[0].runId, runId);
    const evidencePath = 'raw/' + digest + '.json';
    const observation = { authority: 'firestore-sdk', inputDigest, results, evidence: {
      path: evidencePath, sha256: digest, pointers: Object.fromEntries(probe.cases.map(id => [id, '/rows/' + id + '/decision'])),
    } };
    return { directory, evidencePath, bytes, observation };
  });
  for (const { directory, evidencePath, bytes, observation } of files) {
    mkdirSync(join(directory, 'raw'), { recursive: true });
    mkdirSync(join(directory, 'observations'), { recursive: true });
    immutable(join(directory, evidencePath), bytes, { identicalOk: true });
    immutable(join(directory, 'observations', 'sdk-' + runId + '.json'), jsonBytes(observation), { identicalOk: true });
  }
  console.log('Imported', files.length, 'stock probe receipts for', runId);
}

try {
  const [action, archive, runId, ...rest] = process.argv.slice(2);
  assert.ok(!rest.length && (action === 'capture' && archive && !runId || action === 'import-reviewed' && archive && runId || action === 'check-inputs' && !archive), 'see controller/README.md for usage');
  const probes = stockProbes();
  if (action === 'check-inputs') console.log(JSON.stringify(probes.map(({ game, probe }) => ({ game, cases: probe.cases }))));
  if (action === 'capture') await capture(privateArchive(archive), probes);
  if (action === 'import-reviewed') importReviewed(privateArchive(archive), runId, probes);
} catch (error) {
  console.error('Stock controller failed', errorDetails(error));
  process.exitCode = 1;
}
