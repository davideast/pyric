import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wireFields } from '../../../../adapters/arcade-sdk/v1/evidence.mjs';
import { createDocument,lite } from '../../../../arcade/live/controller/clients.mjs';
import { decision,move,snapshot } from '../../live/snapshots.mjs';
import { refereeServer } from '../../live/referee.mjs';
import { boundaryCases,boundarySeed,lifecycleOperations,stamp } from './admission-fixtures.mjs';

export async function admissionCases({mode,config,gameBuild,enginePath,native,runId,writer,guest,reader,verify,journal}) {
  assert.equal(mode,'referee');
  const engineUrl = pathToFileURL(resolve(enginePath));
  const engine = await import(engineUrl), matchPolicy = await import(new URL('./chess-match.mjs',engineUrl));
  const actors = {host:writer,guest,reader};
  const identities = Object.fromEntries(Object.entries(actors).map(([k,client]) => {
    assert.equal(client.identity.uid,client.auth.currentUser.uid);
    return [k,client.identity.uid];
  }));
  assert.equal(new Set(Object.values(identities)).size,3);
  const key = id => runId+'-boundary-'+id;
  const allowed = new Set(boundaryCases.filter(c=>c.uci).map(c=>key(c.id)));
  const server = await refereeServer({config,gameBuild,engine,matchPolicy,verify,journal,allowed});
  const rows = [];
  try {
    for (const c of boundaryCases) {
      const proof = await verify(), id = 'boundary-'+c.id, matchId = key(c.id), path = 'chess/'+matchId;
      const actor = c.role ? identities[c.role] : null;
      const seed = boundarySeed(c,native,identities);
      await createDocument(path,{...wireFields(seed),createdAt:{timestampValue:stamp}});
      const submitted = c.uci ? [{op:'referee-move',path,ply:c.ply,uci:c.uci}] : lifecycleOperations(c,matchId,native,identities);
      const paths = [...new Set([path,...submitted.map(op=>op.path)])];
      const read = () => Promise.all(paths.map(p=>snapshot(reader,p)));
      const before = await read();
      assert.deepEqual(before[0].data,{...seed,createdAt:lite.Timestamp.fromMillis(Date.parse(stamp)).toJSON()});
      assert.ok(before.slice(1).every(s=>s.data===null));
      let observed, responseFields = {};
      const recordsBefore = server.records.length;
      if (c.uci) {
        const headers = {origin:server.origin,'content-type':'application/json'};
        if (actor !== null) headers.authorization = 'Bearer '+await actors[c.role].auth.currentUser.getIdToken();
        const result = await fetch(server.origin+'/move',{method:'POST',headers,redirect:'error',
          body:JSON.stringify({id:matchId,ply:c.ply,uci:c.uci})});
        const {requirement} = await result.json();
        responseFields = {status:result.status,requirement};
        observed = result.status===200 ? 'ALLOW' : 'DENY';
      } else {
        const db = actors[c.role].lite;
        observed = await decision(async () => {
          if (submitted[0].op==='update') return lite.updateDoc(lite.doc(db,path),submitted[0].data);
          const batch = lite.writeBatch(db);
          for (const op of submitted) {
            const data = {...op.data};
            for (const field of op.serverTimestamp ?? []) data[field] = lite.serverTimestamp();
            batch.set(lite.doc(db,op.path),data);
          }
          return batch.commit();
        });
      }
      const after = await read(), end = await verify(), expected = c.requirement==='committed'?'ALLOW':'DENY';
      const row = {id,actor,reader:identities.reader,submitted,expected,observed,...responseFields,
        before,after,proof,end,probe:{fen:c.fen}};
      journal.event('chess-attempt',row);
      rows.push(row);
      assert.equal(observed,expected,id);
      if (c.uci) assert.deepEqual(responseFields,{status:c.status,requirement:c.requirement},id);
      assert.equal(server.records.length-recordsBefore,c.uci && actor!==null ? 1 : 0,id);
      if (observed==='DENY') assert.deepEqual(after,before,id);
      else {
        assert.deepEqual(after[0].data,{...before[0].data,...native.moveUpdate(before[0].data,move(c.uci))},id);
        assert.notEqual(after[0].version,before[0].version,id);
      }
    }
    return {rows,refereeRecords:server.records};
  } finally { await server.close(); }
}
