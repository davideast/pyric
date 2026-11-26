import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api, dbName, dbUrl } from '../../../arcade/live/control.mjs';
import { target, wireFields } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { readDocument } from '../../../arcade/live/controller/clients.mjs';
import { fromPolicy, unpack } from './snapshots.mjs';

async function authenticate(config, header) {
  const token = /^Bearer ([\w.-]{1,8192})$/.exec(header || '')?.[1];
  if (!token) return null;
  const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(config.apiKey),
    {method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({idToken:token}),signal:AbortSignal.timeout(10000)});
  if (!response.ok) return null;
  const {users} = await response.json();
  const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
  return users?.length === 1 && users[0].localId === claims.sub && !users[0].disabled &&
    claims.aud === target.project && claims.iss === 'https://securetoken.google.com/' + target.project &&
    claims.exp > Date.now()/1000 ? claims.sub : null;
}

export async function refereeServer({config, gameBuild, engine, matchPolicy, verify, journal, allowed, beforeCommit}) {
  const openedAt = Date.now();
  const originFor = () => 'http://127.0.0.1:' + server.address().port;
  const records = [];
  async function admit(req) {
    if (req.headers.origin !== originFor()) return [403,'origin'];
    const uid = await authenticate(config,req.headers.authorization);
    if (!uid) return [401,'identity'];
    let body = '';
    for await (const part of req) {body += part; if (body.length > 512) return [413,'input'];}
    let input;
    try { input = JSON.parse(body); } catch { return [400,'input']; }
    const {id,ply,uci} = input ?? {};
    if (typeof id !== 'string' || !/^[\w-]{1,90}$/.test(id) || !Number.isSafeInteger(ply) ||
        !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return [400,'input'];
    const proof = await verify();
    const path = 'chess/' + id;
    let before;
    try { before = await readDocument(path); }
    catch (e) { if (e.message.endsWith(' 404 NOT_FOUND')) return [404,'match']; throw e; }
    const doc = unpack(before.fields);
    if (!allowed.has(id)) {
      if (Date.parse(before.createTime) < openedAt || doc.host !== uid) return [403,'sessionMatch'];
      allowed.add(id);
    }
    let verdict = matchPolicy.admit(doc,uid,ply);
    let comparedVersion;
    if (verdict === 'ok') {
      const patch = fromPolicy(engine,matchPolicy,doc,uci);
      if (!patch) verdict = 'legalMove';
      else {
        if (beforeCommit) await beforeCommit(id,ply,before.updateTime);
        comparedVersion = before.updateTime;
        try {
          await api(dbUrl + '/documents:commit','POST',{writes:[{update:{name:dbName+'/documents/'+path,fields:wireFields(patch)},
            updateMask:{fieldPaths:Object.keys(patch)},currentDocument:{updateTime:before.updateTime}}]});
          verdict = 'committed';
        } catch (e) {
          if (/ (FAILED_PRECONDITION|ABORTED)$/.test(e.message)) verdict = 'matchVersion';
          else throw e;
        }
      }
    }
    const after = await readDocument(path);
    const end = await verify();
    const record = {uid,id,ply,uci,verdict,comparedVersion,beforeVersion:before.updateTime,afterVersion:after.updateTime,
      before:doc,after:unpack(after.fields),proof,end};
    journal.event('referee',record); records.push(record);
    return [verdict === 'committed' ? 200 : 409, verdict];
  }
  const server = createServer(async (req,res) => {
    const reply = (status,value) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if (req.headers.host !== originFor().slice(7)) return reply(403,{requirement:'host'});
      if (req.url === '/move' && req.method === 'POST') {
        const [status,requirement] = await admit(req); return reply(status,{requirement});
      }
      if (req.method !== 'GET') return reply(405,{});
      if (req.url === '/config') return reply(200,{firebase:config,database:target.database});
      const path = req.url === '/' ? 'index.html' : /^\/(assets\/[\w.-]+)$/.exec(req.url)?.[1];
      if (!path) return reply(404,{});
      const bytes = await readFile(join(gameBuild,'app/dist',path));
      const ext = path.split('.').at(-1);
      res.writeHead(200,{'content-type':{js:'text/javascript',css:'text/css',html:'text/html',png:'image/png',woff:'font/woff',woff2:'font/woff2'}[ext] || 'application/octet-stream'});res.end(bytes);
    } catch (e) {console.error('Referee request failed',e.name,String(e.message).slice(0,120));reply(500,{requirement:'service'});}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  assert.equal(config.projectId,target.project);
  return {origin:originFor(),records,close:() => new Promise(resolve => {server.close(resolve);server.closeIdleConnections();})};
}
