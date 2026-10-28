// Child-process fixture for node-realm-ws.test.ts. It runs under Node, not
// Bun: Bun replaces the `ws` package with its own WebSocket, which has no
// 'upgrade' event and no net.Socket. Prints one JSON line.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

const [, , distRealm] = process.argv;
const { releaseUpgradedSocket } = await import(distRealm);
// The same `ws` the realm loads: resolved from the realm's own location.
const wsEntry = pathToFileURL(createRequire(distRealm).resolve('ws')).href;
const ws = (await import(wsEntry)).default;
const WebSocket = ws.WebSocket ?? ws;
const WebSocketServer = ws.WebSocketServer ?? ws.Server;

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
// Registered before the realm's listener, so it sees the socket first and
// records the realm's unref() call on it.
let unrefCalls = 0;
const upgraded = new Promise((resolve) => socket.once('upgrade', (response) => {
  const upgradedSocket = response.socket;
  const unref = upgradedSocket?.unref?.bind(upgradedSocket);
  if (unref) upgradedSocket.unref = () => { unrefCalls += 1; return unref(); };
  resolve(upgradedSocket);
}));
const opened = new Promise((resolve) => socket.once('open', resolve));
const warnings = [];
releaseUpgradedSocket(socket, (message) => warnings.push(message));
const candidate = await upgraded;
await opened;
const result = {
  upgradeGivesNetSocket: candidate instanceof Socket,
  unreferenced: unrefCalls === 1,
  warningsWithSocket: warnings.length,
};
socket.terminate();
for (const client of server.clients) client.terminate();
await new Promise((resolve) => server.close(resolve));

const fake = new EventEmitter();
releaseUpgradedSocket(fake, (message) => warnings.push(message));
fake.emit('upgrade', {});
fake.emit('open');
result.warningsWithoutSocket = warnings.length;
result.warning = warnings[0] ?? null;
console.log(JSON.stringify(result));
