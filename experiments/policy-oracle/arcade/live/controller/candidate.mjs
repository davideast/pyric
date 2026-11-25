import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha, manifest } from '../../corpus.mjs';
import { materialize } from '../../../adapters/arcade-sdk/v1/fixture.mjs';
import { errorDetails, startJournal } from './archive.mjs';
import { floorCase, floorPropagation, floorRecipe, runCase } from './candidate-case.mjs';
import { clientsFor } from './clients.mjs';
import { counterPropagation } from './counter-controls.mjs';
import { stockProbes } from './probes.mjs';
import { withRelease } from './release.mjs';

function pinned(path, digest) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), digest, 'supplied digest differs from file bytes');
  return bytes;
}

async function main(args) {
  const [mode, archive, sourcePath, digest, recipePath, recipeSha] = args;
  assert.ok(mode === 'floor' && args.length === 6 || mode === 'sokoban' && args.length === 4, 'invalid candidate capture arguments');
  const source = pinned(sourcePath, digest).toString('utf8');
  assert.notEqual(digest, manifest.files['v1/rules/stock.rules']);
  const { probe } = stockProbes().find(p => p.game === 'sokoban');
  const recipe = mode === 'floor' ? floorRecipe(JSON.parse(pinned(recipePath, recipeSha))) : probe.fixture;
  const fixtureSha256 = mode === 'floor' ? recipeSha : probe.fixtureSha256;
  const runId = randomUUID();
  const journal = startJournal(archive, runId);
  console.log('Candidate capture journal', journal.directory);
  const clients = clientsFor(runId, journal);
  let stopping = false;
  const interrupt = () => { stopping = true; };
  const checkStop = () => assert.ok(!stopping, 'capture interrupted');
  let writer, reader, second;
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  try {
    let receipt;
    try {
      receipt = await withRelease({ runId, journal, source, digest, checkStop,
        async setupClients(config) {
          writer = await clients.add('writer', config);
          reader = await clients.add('reader', config);
          if (mode === 'sokoban') second = await clients.add('second-writer', config);
        },
        async checkPropagation(phase, proof) {
          const context = { phase, proof, runId, writer, reader, journal, checkStop };
          return mode === 'floor' ? floorPropagation({ ...context, recipe }) : counterPropagation(context);
        },
        async capture(verify) {
          const rows = {};
          for (const [index, { id }] of recipe.cases.entries()) {
            checkStop();
            const owner = mode === 'sokoban' && index === 1 ? second : writer;
            const sample = mode === 'floor' ? floorCase(recipe, id, owner, reader, runId)
              : materialize(recipe, id, { runId, actor: owner.identity.uid, reader: reader.identity.uid });
            const row = await runCase({ sample, writer: owner, reader, journal, runId, tag: mode, verify });
            assert.equal(row.deploymentBefore.rulesSha256, digest);
            assert.equal(row.deploymentAfter.rulesSha256, digest);
            assert.equal(row.deploymentAfter.rulesetName, row.deploymentBefore.rulesetName);
            assert.equal(row.deploymentAfter.propagationReceiptSha256, row.deploymentBefore.propagationReceiptSha256);
            rows[id] = row;
            console.log(mode, id, row.decision);
          }
          const evidence = { mode, runId, rulesSha256: digest, fixtureSha256, rows };
          return journal.retain(evidence);
        },
      });
    } finally { await clients.close(); }
    journal.complete({ mode, runId, rulesSha256: digest, fixtureSha256, receipt });
    console.log('Completed candidate capture', runId, 'receipt', receipt);
  } catch (error) {
    journal.event('failure', errorDetails(error));
    throw error;
  } finally {
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
}
try { await main(process.argv.slice(2)); }
catch (error) { console.error('Candidate controller failed', errorDetails(error)); process.exitCode = 1; }
