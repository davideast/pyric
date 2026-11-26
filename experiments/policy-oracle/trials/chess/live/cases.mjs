import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { lite } from '../../../arcade/live/controller/clients.mjs';
import { decision, move, snapshot } from './snapshots.mjs';

export async function protocol({runId, writer, guest, reader, verify, journal, native, mode, unauth}) {
  const rows = [];
  const match = 'chess/' + runId;
  const waiting = match + '-waiting';
  const next = match + '-rematch';
  const pointer = 'rematches/chess/matches/' + runId;
  const uids = {host: writer.identity.uid, guest: guest.identity.uid};
  const waitingFields = host => ({host, guest:'', status:'waiting', currentTurn:'host', winner:'', moveCount:0, ...native.initialFields()});
  let submitted;
  const create = (client, path, data) => {
    submitted = [{op:'set',path,data,serverTimestamp:['createdAt']}];
    return lite.setDoc(lite.doc(client.lite, path), {...data, createdAt:lite.serverTimestamp()});
  };
  const update = (client, path, patch) => {
    submitted = [{op:'update',path,data:patch}];
    return lite.updateDoc(lite.doc(client.lite, path), patch);
  };
  const remove = (client,path) => {
    submitted = [{op:'delete',path}]; return lite.deleteDoc(lite.doc(client.lite,path));
  };
  async function attempt(id, paths, actor, send, expected, expectedAfter) {
    const proof = await verify();
    const before = await Promise.all(paths.map(p => snapshot(reader, p)));
    submitted = undefined;
    const observed = await decision(send);
    const after = await Promise.all(paths.map(p => snapshot(reader, p)));
    const end = await verify();
    assert.ok(submitted);
    const row = {id, actor:actor.identity.uid, reader:reader.identity.uid, submitted, expected, observed, before, after, proof, end};
    rows.push(row);
    journal.event('chess-attempt', row);
    console.log(mode, id, observed);
    assert.equal(observed, expected, id);
    if (observed === 'DENY') assert.deepEqual(after, before);
    else {
      const states = expectedAfter(before, after);
      assert.deepEqual(after.map(x => x.data), states, id);
      for (let i = 0; i < paths.length; i++) {
        if (isDeepStrictEqual(before[i].data, after[i].data)) assert.equal(after[i].version, before[i].version);
        else assert.notEqual(after[i].version, before[i].version);
      }
    }
    return after[0].data;
  }
  const fresh = waitingFields(uids.host);
  const signedOut = await decision(() => lite.getDoc(lite.doc(unauth, match)));
  assert.equal(signedOut, 'DENY');
  journal.event('unauthenticated-read', {path:match, observed:signedOut});
  const withTimestamp = (fields, observed) => ({...fields,createdAt:observed.data.createdAt});
  await attempt('opening-counter', [match], writer, () => create(writer, match, {...fresh,moveCount:1}), 'DENY');
  await attempt('create', [waiting], writer, () => create(writer, waiting, fresh), 'ALLOW', (_, a) => [withTimestamp(fresh,a[0])]);
  await attempt('cancel-by-guest', [waiting], guest, () => remove(guest,waiting), 'DENY');
  await attempt('cancel-by-host', [waiting], writer, () => remove(writer,waiting), 'ALLOW', () => [null]);
  await attempt('open-match', [match], writer, () => create(writer, match, fresh), 'ALLOW', (_, a) => [withTimestamp(fresh,a[0])]);
  const join = {guest:uids.guest,status:'playing'};
  let state = await attempt('join', [match], guest, () => update(guest, match, join), 'ALLOW', b => [{...b[0].data,...join}]);
  const first = native.moveUpdate(state, move('f2f3'));
  await attempt('wrong-turn', [match], guest, () => update(guest, match, first), 'DENY');
  await attempt('wrong-counter', [match], writer, () => update(writer, match, {...first,moveCount:2}), 'DENY');
  if (mode === 'referee') {
    await attempt('direct-player-move', [match], writer, () => update(writer, match, first), 'DENY');
    return rows;
  }
  for (const uci of ['f2f3','e7e5','g2g4','d8h4']) {
    const actor = state.currentTurn === 'host' ? writer : guest;
    const change = native.moveUpdate(state, move(uci));
    state = await attempt(uci, [match], actor, () => update(actor, match, change), 'ALLOW', b => [{...b[0].data,...change}]);
  }
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 'guest');
  await attempt('terminal-move', [match], writer, () => update(writer, match, first), 'DENY');
  const rematch = {...fresh, rematchOf:runId};
  const link = {game:'chess',match:next.split('/')[1],by:uids.host};
  await attempt('pointer-alone', [pointer,next,match], writer, () => {
    submitted=[{op:'set',path:pointer,data:link}]; return lite.setDoc(lite.doc(writer.lite,pointer),link);
  },'DENY');
  function offer() {
    submitted=[{op:'set',path:next,data:rematch,serverTimestamp:['createdAt']},{op:'set',path:pointer,data:link}];
    const batch = lite.writeBatch(writer.lite);
    batch.set(lite.doc(writer.lite,next), {...rematch, createdAt:lite.serverTimestamp()});
    batch.set(lite.doc(writer.lite,pointer), link);
    return batch.commit();
  }
  await attempt('offer-rematch',[next,pointer,match],writer,offer,'ALLOW',(b,a) => [withTimestamp(rematch,a[0]),link,b[2].data]);
  await attempt('duplicate-offer',[next,pointer,match],writer,offer,'DENY');
  await attempt('join-rematch',[next],guest,() => update(guest,next,join),'ALLOW',b => [{...b[0].data,...join}]);
  const end = {status:'resigned',winner:'host'};
  await attempt('resign-rematch',[next],guest,() => update(guest,next,end),'ALLOW',b => [{...b[0].data,...end}]);
  return rows;
}
