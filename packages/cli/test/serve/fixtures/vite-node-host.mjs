import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';

const root = process.argv[2];
const port = Number(process.argv[3] ?? 0);
const host = process.argv[4] ?? 'localhost';
const server = await createServer({
  configFile: false,
  logLevel: 'silent',
  root,
  plugins: [pyric({ bridge: { disableAuditLog: true } })],
  server: { port, host },
  optimizeDeps: { noDiscovery: true },
});
await server.listen();
const address = server.httpServer?.address();
const hasAddress = address !== null && typeof address === 'object';
const hasNoAddress = !hasAddress;
if (hasNoAddress) throw new Error('Vite did not bind a TCP port');
process.send({ port: address.port });
process.once('message', async message => {
  const closesHost = message === 'close';
  const isUnknownCommand = !closesHost;
  if (isUnknownCommand) throw new Error('Unknown Vite fixture command');
  await server.close();
  process.disconnect();
});
