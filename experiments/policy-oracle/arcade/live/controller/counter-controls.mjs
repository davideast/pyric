import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { materialize } from '../../corpus.mjs';
import { checkWire, wireFields } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { createDocument, lite, readDocument } from './clients.mjs';
import { now } from './archive.mjs';

async function decision(send) {
  try {
    const result = await send();
    return { decision: 'ALLOW', result };
  } catch (error) {
    if (error.code === 'permission-denied') return { decision: 'DENY' };
    throw error;
  }
}

// The frozen count-zero stock controls accept +1 and deny +2. Unlike the
// scored game writes, each attempt has a new synthetic tic-tac-toe document.
export async function counterPropagation({ phase, proof, runId, writer, reader, journal, checkStop }) {
  const open = phase === 'open';
  const controls = [];
  const ids = { host: writer.identity.uid, guest: reader.identity.uid };
  const started = Date.now();
  let streak = 0;
  do {
    if (phase !== 'restored-closed') checkStop();
    const round = [];
    for (const count of open ? [1, 2] : [1]) {
      const { before, proposal } = materialize({ id: 'zero/stock/control', count }, ids);
      const path = 'tictactoe/' + runId + '-control-' + randomUUID();
      const { createdAt, ...fields } = before;
      const timestamp = new lite.Timestamp(createdAt.seconds, createdAt.nanoseconds);
      const seed = await createDocument(path, { ...wireFields(fields), createdAt: { timestampValue: timestamp.toDate().toISOString() } });
      const previousVersion = checkWire(seed, path, before);
      const ref = lite.doc(reader.lite, path);
      const read = await decision(() => lite.getDoc(ref));
      if (read.decision === 'ALLOW') {
        assert.ok(read.result.exists());
        assert.deepEqual(JSON.parse(JSON.stringify(read.result.data())), before);
      }
      const write = await decision(() => lite.setDoc(lite.doc(writer.lite, path), { ...proposal, createdAt: timestamp }));
      const expectedStored = write.decision === 'ALLOW' ? proposal : before;
      const after = await readDocument(path);
      const version = checkWire(after, path, expectedStored);
      assert.ok(write.decision === 'ALLOW' ? version > previousVersion : version === previousVersion);
      const post = await decision(() => lite.getDoc(ref));
      let snapshot;
      if (post.decision === 'ALLOW') {
        assert.ok(post.result.exists());
        snapshot = JSON.parse(JSON.stringify(post.result.data()));
        assert.deepEqual(snapshot, expectedStored);
      }
      const record = { path, count, seed, before, proposal, beforeRead: read.decision, write: write.decision,
        afterRead: post.decision, snapshot, after, at: now() };
      controls.push(record);
      journal.event('propagation-control', { phase, ...record });
      const expectedAccess = open ? 'ALLOW' : 'DENY';
      round.push(read.decision === expectedAccess && post.decision === expectedAccess &&
        write.decision === (open && count === 1 ? 'ALLOW' : 'DENY'));
    }
    streak = round.every(Boolean) ? streak + 1 : 0;
    if (streak === 2) {
      const digest = journal.retain({ phase, proof, identities: ids, controls });
      journal.event('propagation-confirmed', { phase, proof, digest });
      return digest;
    }
    await delay(2500);
  } while (Date.now() - started < 240000);
  throw new Error('data-plane propagation timed out');
}
