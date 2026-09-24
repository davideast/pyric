import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';

// The host compares project directories by their real path.
const directory = realpathSync(process.argv[2]);
const SESSION = 'session-token-for-the-mount';
const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void mount.handler(request, response, url).then(handled => {
    if (!handled) response.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, sessionToken: SESSION };

try {
  await mount.startHostedSandbox(payload, base);
  // Store an object through the hosted method route, as a service command would.
  const stored = await fetch(`${base}/__pyric/hosted/method`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: mount.instanceId, projectDir: directory, key: 'storage.uploadBytes',
      args: { path: 'notes/note.txt', contentBase64: Buffer.from('a short note').toString('base64'), metadata: { contentType: 'text/plain' } } }),
  });
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).ok, true);

  // The hosted host serves its objects on the byte route, to the session.
  const url = `${base}/__pyric/storage/v0/b/pyric-default/o/${encodeURIComponent('notes/note.txt')}?alt=media`;
  const read = await fetch(url, { headers: { 'x-pyric-session-token': SESSION } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'text/plain');
  assert.equal(await read.text(), 'a short note');
  assert.equal((await fetch(url)).status, 403);
  // A page on another local port is a different origin.
  const crossPort = await fetch(url, { headers: { 'x-pyric-session-token': SESSION, origin: `http://127.0.0.1:${address.port + 1}` } });
  assert.equal(crossPort.status, 403);

  // The attach acknowledgement advertises the route.
  mount.attachHost({ servers: [server], projectDir: directory, origin: () => ({ host: '127.0.0.1', port: address.port }) });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/__pyric/sandbox`);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('socket failed')); });
  const ack = new Promise<{ capabilities?: string[] }>(resolve => {
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'attach-ack') resolve(message);
    };
  });
  socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
  const acknowledged = await ack;
  assert.ok(acknowledged.capabilities?.includes('storage-byte-route'), `capabilities: ${acknowledged.capabilities?.join(', ')}`);
  socket.close();
} finally {
  await mount.close();
  server.close();
}

console.log('Byte route mount passed');
