// Drives a real hosted Vite dev server on Node and fetches `/` as both a
// remote peer and a local loopback peer, printing one JSON report.
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'vite';

const [root] = process.argv.slice(2);

async function freePort() {
  const probe = createNetServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function getRawHtml(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const report = {};
let server = null;
try {
  const port = await freePort();
  server = await createServer({
    root,
    configFile: join(root, 'vite.config.mjs'),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      allowedHosts: ['remote.example'],
    },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();

  report.remote = await getRawHtml(port, '/', {
    host: 'remote.example',
    accept: 'text/html',
    'x-pyric-remote-peer': '1',
  });
  report.local = await getRawHtml(port, '/', {
    host: `127.0.0.1:${port}`,
    accept: 'text/html',
  });
  const tokenMatch = /"sessionToken":"([^"]+)"/.exec(report.local.body);
  if (tokenMatch && tokenMatch[1]) {
    const token = tokenMatch[1];
    report.authedRemote = await getRawHtml(port, '/', {
      host: `remote.example:${port}`,
      accept: 'text/html',
      'x-pyric-session-token': token,
    });
    report.authedRemoteInit = await getRawHtml(port, '/__pyric/init.json', {
      host: `remote.example:${port}`,
      'x-pyric-session-token': token,
    });
  }
} catch (error) {
  if (error instanceof Error) {
    report.failure = error.stack ?? error.message;
  } else {
    report.failure = String(error);
  }
} finally {
  if (server !== null) {
    try {
      await server.close();
    } catch (error) {
      if (error instanceof Error) {
        report.closeFailure = error.message;
      } else {
        report.closeFailure = String(error);
      }
    }
  }
}
console.log(JSON.stringify(report));
