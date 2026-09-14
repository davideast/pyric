import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { build } = createRequire(new URL('../../packages/cli/package.json', import.meta.url))('esbuild') as typeof import('esbuild');

/** Real SDK example: independent in-page and SharedWorker execution paths. */
export async function startSdkFlowServer(port = 0) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const resolve = createRequire(new URL('../../packages/studio/package.json', import.meta.url));
  const outdir = join(tmpdir(), 'sdk-flow-example');
  const result = await build({
    entryPoints: [join(here, 'sdk-app.ts')],
    bundle: true, platform: 'browser', format: 'esm', splitting: true,
    target: 'es2022', write: false, outdir,
    plugins: [{ name: 'example-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/client)?$/ }, args => ({ path: resolve.resolve(args.path) }));
    } }],
  });
  const worker = await build({ entryPoints: [join(here, 'sdk-worker.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false });
  const assets = new Map(result.outputFiles.map(file => [file.path.slice(outdir.length), file.text]));
  assets.set('/sdk-worker.js', worker.outputFiles[0]!.text);
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (assets.has(path)) { res.setHeader('Content-Type', 'text/javascript'); res.end(assets.get(path)); return; }
    if (path === '/__pyric/flow/manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end('{"treatments":[]}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><style>
      .security-lab{display:grid;gap:16px;max-width:700px}.security-lab p,.security-lab h2,.security-lab pre{all:unset}.security-lab h2{font-size:24px;font-weight:600}.security-lab pre{font-family:monospace;white-space:pre-wrap;overflow-wrap:anywhere}.security-lab select{font:inherit;min-height:40px}.security-proposed{display:grid;gap:8px}html{color-scheme:dark;font:16px system-ui;background:#101419;color:#e7ebf1}
      body{display:grid;grid-template-columns:32px minmax(0,1fr) 32px;gap:24px}
      #app{grid-column:2;display:grid;gap:24px;min-height:400px;max-width:700px}
      section{display:grid;gap:24px;align-content:start} .controls{display:flex;flex-wrap:wrap;gap:12px}
      button{min-height:36px;min-width:140px} article{min-height:100px;display:grid;align-items:center;border:1px solid #404858}
      </style></head><body><main id="app"></main><script type="module" src="/sdk-app.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
if (import.meta.main) {
  const server = await startSdkFlowServer(Number(process.env.SDK_FLOW_PORT ?? 5198));
  console.log(`SDK Flow: ${server.url}/?runtime=inpage or ?runtime=worker`);
}
