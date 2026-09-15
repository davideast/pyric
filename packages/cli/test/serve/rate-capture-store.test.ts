import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { buildMcpServer } from '../../src/bridge/server/mcp.js';
import { getBridgeToolSurface } from '../../src/bridge/server/mcp-contract.js';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRateCaptureStore } from '../../src/serve/rate-capture-store.js';
import { buildRateCapture } from '../../src/serve/runtime/rate-capture.js';
import { projectCaptures } from '../../src/serve/runtime/project-captures.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { startStaticServer, silentServeLogger } from '../../src/serve/server.js';
import save from '../../src/bridge/surface/methods/sandbox/saveCapture.js';
import list from '../../src/bridge/surface/methods/sandbox/listCaptures.js';
import open from '../../src/bridge/surface/methods/sandbox/openCapture.js';
import { createSurfaceContext } from '../../src/bridge/surface/context.js';
import { initializeSandbox } from 'pyric/sandbox';

const counts = { reads: 2, writes: 4, deletes: 0, deliveries: 1 };
const text = JSON.stringify(buildRateCapture({ service: { service: 'rtdb', coverage: 'partial', observed: true, untrackedMethods: [], methods: [] }, points: [{ second: 10, ...counts }], from: 10, to: 10, duration: 1, clockOffset: 1000, paused: true, totals: counts, peaks: counts }, {}, [], { marker: 'full session attachment' }));

test('HTTP and sandbox tools share project captures across host recreation, without altering sandbox or live fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyric-captures-'));
  await mkdir(join(root, 'public')); await writeFile(join(root, 'public/index.html'), '<html></html>');
  await mkdir(join(root, '.pyric')); await writeFile(join(root, '.pyric/last-session.json'), 'live fixture');
  const namespace = createPyricNamespace({ sdkDir: root, rateCaptures: createRateCaptureStore(root), initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }) });
  const server = await startStaticServer({ publicDir: join(root, 'public'), port: 0, host: '127.0.0.1', namespaceHandler: namespace, logger: silentServeLogger() });
  const sandbox = initializeSandbox({ projectId: 'capture-tests' });
  try {
    const init = await (await fetch(server.url + '/__pyric/init.json')).json();
    const endpoint = server.url + '/__pyric/rate-captures';
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { method: 'POST', headers: { origin: 'https://example.com', 'x-pyric-session-token': init.sessionToken }, body: text })).status).toBe(403);
    const client = projectCaptures(((path: string, options?: RequestInit) => fetch(server.url + path, options)) as typeof fetch);
    const saved = (await client.save(text))!;
    await client.rename(saved.id, 'Named from the chip');
    expect((await client.list())?.find(entry => entry.id === saved.id)?.name).toBe('Named from the chip');
    expect((await fetch(`${endpoint}?id=${saved.id}`, { method: 'DELETE', headers: { 'x-pyric-session-token': init.sessionToken, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: false }) })).status).toBe(400);
    const ctx = createSurfaceContext(sandbox, root);
    const history = sandbox.history();
    const listed = await list.handler({}, ctx);
    expect(listed.data.captures[0]?.id).toBe(saved.id);
    expect((await open.handler({ id: saved.id }, ctx)).data.sessionFixture.fixture.marker).toBe('full session attachment');
    const toolSaved = await save.handler({ capture: text }, ctx);
    expect(toolSaved.data.id).not.toBe(saved.id);
    expect(await client.list()).toHaveLength(2);
    expect(JSON.parse(await client.read(toolSaved.data.id)).frame.totals.writes).toBe(4);
    expect(await createRateCaptureStore(root).read(saved.id)).toBe(text);
    const bridge = createBridge({ project: 'capture-test', version: 'test' });
    const mcp = buildMcpServer(bridge, getBridgeToolSurface({ projectDir: root }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'capture-test', version: 'test' });
    await mcp.connect(serverTransport); await agent.connect(clientTransport);
    try {
      expect((await agent.listTools()).tools.map(tool => tool.name)).toContain('sandbox_open_capture');
      const result = await agent.callTool({ name: 'sandbox_open_capture', arguments: { id: saved.id } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('full session attachment');
      const created = await agent.callTool({ name: 'sandbox_save_capture', arguments: { capture: text } });
      expect(created.isError).not.toBe(true);
      expect(await client.list()).toHaveLength(3);
    } finally { await agent.close(); await mcp.close(); }

    expect(sandbox.history()).toEqual(history);
    expect(await readFile(join(root, '.pyric/last-session.json'), 'utf8')).toBe('live fixture');
    await expect(client.save('{}')).rejects.toThrow('valid measurements');
    await expect(client.read('../last-session')).rejects.toThrow('Invalid capture id');
  } finally { sandbox.dispose(); await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test('capture store rejects redirected folders, symlinks, and oversized or corrupt files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyric-capture-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'pyric-capture-outside-'));
  try {
    await symlink(outside, join(root, '.pyric'));
    await expect(createRateCaptureStore(root).save(text)).rejects.toThrow('inside the project');
    await rm(join(root, '.pyric'));
    const store = createRateCaptureStore(root);
    const saved = await store.save(text);
    await rm(join(store.directory, `${saved.id}.json`));
    await writeFile(join(outside, 'foreign.json'), text);
    await symlink(join(outside, 'foreign.json'), join(store.directory, `${saved.id}.json`));
    await expect(store.read(saved.id)).rejects.toThrow('Invalid capture file');
    expect(await store.list()).toEqual([]);
    await expect(store.save(' '.repeat(32 * 1024 * 1024 + 1))).rejects.toThrow('32 MB');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('names persist separately, and confirmed deletion removes only its saved snapshot across transports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyric-capture-management-'));
  const sandbox = initializeSandbox();
  try {
    const store = createRateCaptureStore(root);
    const first = await store.save(text);
    const second = await store.save(text);
    await store.rename(first.id, '  <Message burst>  ');
    const reopened = createRateCaptureStore(root);
    expect((await reopened.list()).find(entry => entry.id === first.id)?.name).toBe('<Message burst>');
    expect(await reopened.read(first.id)).toBe(text);
    expect((await reopened.list()).find(entry => entry.id === first.id)?.savedAt).toBe((await store.list()).find(entry => entry.id === first.id)?.savedAt);
    await expect(store.rename(first.id, 'x'.repeat(81))).rejects.toThrow('80');
    await expect(store.rename(first.id, 'bad\nname')).rejects.toThrow('one line');
    await store.rename(first.id, '');
    expect((await store.list()).find(entry => entry.id === first.id)?.name).toBeNull();
    const tools = getBridgeToolSurface({ projectDir: root }).inProcess;
    const remove = tools.find(tool => tool.name === 'sandbox_delete_capture')!;
    const context = { signal: new AbortController().signal } as never;
    expect((await remove.execute({ id: first.id, confirm: false }, context)).ok).toBe(false);
    expect(await store.read(first.id)).toBe(text);
    expect((await remove.execute({ id: first.id, confirm: true }, context)).ok).toBe(true);
    await expect(store.read(first.id)).rejects.toThrow();
    expect(await store.read(second.id)).toBe(text);
    expect(await store.list()).toHaveLength(1);
  } finally { sandbox.dispose(); await rm(root, { recursive: true, force: true }); }
});
