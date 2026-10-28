import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
// pyric-admin is not linked into node_modules; the runner rewrites ../../../src/ to the cli build, beside pyric-admin's.
import { deleteApp, initializeApp } from '../../../src/../../pyric-admin/dist/app/index.js';
import { getDatabase, getDatabaseWithUrl } from '../../../src/../../pyric-admin/dist/database/index.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';

// An admin write through getDatabaseWithUrl(shard) on the Node host lands in
// the shard instance: a signed-in client reads it there under the shard's
// rules, and neither the client nor the admin sees it through the default.
const directory = realpathSync(process.argv[2]);
const SESSION = 'session-token-for-admin-rtdb-instances';
const SHARD = 'demo-app-shard-1';
const SHARD_URL = `https://${SHARD}.firebaseio.com`;
const DEFAULT_URL = 'https://demo-app-default-rtdb.firebaseio.com';
const MEMBERS_ONLY = JSON.stringify({
  rules: { rooms: { $roomId: { '.read': "auth != null && data.child('members').child(auth.uid).exists()" } } },
});

const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/__pyric/init.json') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionToken: SESSION }));
    return;
  }
  void mount.handler(request, response, url).then(handled => { if (!handled) response.writeHead(404).end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
await mount.startHostedSandbox({ rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, sessionToken: SESSION }, base);
mount.attachHost({ servers: [server], projectDir: directory, origin: () => ({ host: '127.0.0.1', port: address.port }) });
await mount.deployHostedRules('database', MEMBERS_ONLY);
await mount.deployHostedRules('database', MEMBERS_ONLY, SHARD);

const adminSide = await connectRemoteSandbox({ url: base });
const client = await connectRemoteSandbox({ url: base });
const app = initializeApp({ sandbox: adminSide, projectId: 'demo-app' }, 'admin-rtdb-instances');

try {
  const signedIn = await client.channel.op({ method: 'auth.signInAnonymously' }) as { user: { uid: string } };
  const uid = signedIn.user.uid;
  await getDatabaseWithUrl(SHARD_URL, app).ref('rooms/r1').set({ members: { [uid]: true } });

  // The client reads the room through the shard, under the shard's rules.
  const onShard = await client.channel.op({ method: 'rtdb.get', instance: SHARD, path: 'rooms/r1' }) as { value: unknown };
  assert.deepEqual(onShard.value, { members: { [uid]: true } });
  // Through the default instance the room does not exist, so the rule denies the read.
  await assert.rejects(
    client.channel.op({ method: 'rtdb.get', instance: undefined, path: 'rooms/r1' }),
    /permission/i,
  );
  // The admin reads the room through the shard URL and not through the default URL.
  assert.deepEqual((await getDatabaseWithUrl(SHARD_URL, app).ref('rooms/r1').get()).val(), { members: { [uid]: true } });
  assert.equal((await getDatabaseWithUrl(DEFAULT_URL, app).ref('rooms/r1').get()).exists(), false);
  assert.equal((await getDatabase(app).ref('rooms/r1').get()).exists(), false);
} finally {
  await deleteApp(app);
  await adminSide.close?.();
  await client.close?.();
  await mount.close();
  server.close();
}

console.log('Admin RTDB instances passed');
