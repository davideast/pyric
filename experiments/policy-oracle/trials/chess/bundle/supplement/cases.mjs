import assert from 'node:assert/strict';
import { wireFields } from '../../../../adapters/arcade-sdk/v1/evidence.mjs';
import { lite, createDocument } from '../../../../arcade/live/controller/clients.mjs';
import { decision, snapshot } from '../../live/snapshots.mjs';
import { cases, fen, initial, isoTime, proposal } from './fixtures.mjs';

export async function supplementalCases({mode,runId,writer,guest,reader,native,verify,journal}) {
  assert.ok(['stock','compatibility','stronger'].includes(mode));
  const rows = [];
  for (const c of cases.filter(c => Object.hasOwn(c.expected,mode))) {
    const proof = await verify();
    const id = 'supplement-' + c.id, path = 'chess/' + runId + '-' + id;
    const expected = c.expected[mode], actor = writer.identity.uid;
    assert.equal(writer.auth.currentUser.uid, actor);
    assert.equal(reader.auth.currentUser.uid, reader.identity.uid);
    assert.notEqual(reader.identity.uid,actor);
    const seed = initial(native,actor,guest.identity.uid);
    await createDocument(path,{...wireFields(seed),createdAt:{timestampValue:isoTime}});
    const before = await snapshot(reader,path);
    assert.deepEqual(before.data,{...seed,createdAt:lite.Timestamp.fromMillis(Date.parse(isoTime)).toJSON()});
    const patch = proposal(native,before.data,c), submitted = [{op:'update',path,data:patch}];
    const observed = await decision(() => lite.updateDoc(lite.doc(writer.lite,path),patch));
    const after = await snapshot(reader,path), end = await verify();
    const row = {id, actor, reader:reader.identity.uid, submitted, expected, observed,
      before:[before],after:[after],proof,end,probe:{fen,uci:c.uci ?? 'g1f3',field:c.field ?? null}};
    journal.event('chess-attempt',row);
    rows.push(row);
    assert.equal(observed,expected,id);
    if (observed === 'ALLOW') {
      assert.deepEqual(after.data,{...before.data,...patch},id);
      assert.notEqual(after.version,before.version,id);
    } else assert.deepEqual(after,before,id);
  }
  return rows;
}
