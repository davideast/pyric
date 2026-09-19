import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';
const port = Number(process.env.PORT ?? 0);
const hasFixedPort = port !== 0;
const server = await createServer({
  root: process.cwd(), configFile: false, logLevel: 'silent',
  cacheDir: '.vite',
  plugins: [pyric({ capture: false, ui: false, bridge: true })],
  server: { host: '127.0.0.1', port, strictPort: hasFixedPort },
});
await server.listen();
console.log(JSON.stringify({ url: server.resolvedUrls.local[0] }));
process.once('SIGTERM', async () => { await server.close(); process.exit(0); });
process.once('SIGINT', async () => { await server.close(); process.exit(0); });
