// Verifies four host/MCP/discovery guarantees against the packed @pyric/cli:
// 1. Standalone bridge handles malformed and empty Host headers cleanly without unhandled rejections.
// 2. HTTP MCP endpoints stamp configured projectDir and isProject even when started from another cwd.
// 3. CLI and MCP discovery respect non-.1 loopback hosts (--host 127.0.0.2) without a 10s stall.
// 4. `pyric mcp` host-stop fallback acquires in-process persistence and retains writes across sessions.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { scenario, sleep } from '../driver.ts';

interface ServePointer {
  url?: string;
  mcpUrl?: string;
  port?: number;
  instanceId?: string;
  token?: string;
}

function postHostedMethod(
  host: string,
  port: number,
  pointer: ServePointer,
  projectDir: string,
  key: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      instanceId: pointer.instanceId,
      projectDir,
      key,
      args,
    });
    const headers: Record<string, string> = {
      host: `${host}:${port}`,
      'content-type': 'application/json',
    };
    if (pointer.token) headers['x-pyric-session-token'] = pointer.token;
    const req = httpRequest(
      { host, port, path: '/__pyric/hosted/method', method: 'POST', headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          if (raw) {
            body = JSON.parse(raw) as Record<string, unknown>;
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseSseOrJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Record<string, unknown>;
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    }
  }
  throw new Error(`Unparseable HTTP MCP body: ${text}`);
}

function parseCliJson(output: string): Record<string, unknown> {
  const start = output.indexOf('{');
  if (start === -1) {
    throw new Error(`Missing JSON payload in CLI output:\n${output}`);
  }
  return JSON.parse(output.slice(start)) as Record<string, unknown>;
}

export default scenario(async (app) => {
  const realProject = realpathSync(app.dir);
  const unrelatedCwd = join(app.dir, '..', 'unrelated-cwd');
  mkdirSync(unrelatedCwd, { recursive: true });
  const cliPath = join(app.dir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');

  await app.step('standalone bridge rejects malformed Host headers cleanly and stamps configured projectDir', async () => {
    const { code, output } = await app.command('node', ['probe-bridge.mjs', app.dir, unrelatedCwd], {
      timeoutMs: 30_000,
    });
    assert.equal(code, 0, output);
    const line = output.split('\n').find((entry) => entry.startsWith('bridge-probe '));
    assert.ok(line, `missing bridge-probe output:\n${output}`);
    const parsed = JSON.parse(line.slice('bridge-probe '.length)) as {
      realProjectDir: string;
      stampedProjectDir: string | null;
      isProject: boolean | null;
      instructionsHasProjectDir: boolean;
      warnsNoMarkers: boolean;
    };
    assert.equal(parsed.stampedProjectDir, parsed.realProjectDir);
    assert.equal(parsed.isProject, true);
    assert.equal(parsed.instructionsHasProjectDir, true);
    assert.equal(parsed.warnsNoMarkers, false);
  });

  const port = await app.freePort();
  const pointerPath = join(app.dir, '.pyric', 'serve.json');

  const { hostProc, pointer } = await app.step(
    'start hosted sandbox on 127.0.0.2 and seed items/loop2 directly',
    async () => {
      const proc = app.pyricProcess([
        'sandbox',
        '--hosted',
        '--no-open',
        '--no-run',
        '--host',
        '127.0.0.2',
        '--port',
        String(port),
      ]);
      const deadline = Date.now() + 45_000;
      let parsed: ServePointer | null = null;
      while (Date.now() < deadline) {
        if (existsSync(pointerPath)) {
          try {
            const candidate = JSON.parse(readFileSync(pointerPath, 'utf8')) as ServePointer;
            if (candidate.url) {
              parsed = candidate;
              break;
            }
          } catch {
            // Wait for complete atomic write.
          }
        }
        await sleep(150);
      }
      assert.ok(parsed?.url, `serve.json not written:\n${proc.output}`);
      const boundPort = Number(new URL(parsed.url).port);
      const seeded = await postHostedMethod(
        '127.0.0.2',
        boundPort,
        parsed,
        realProject,
        'firestore.setDoc',
        { path: 'items/loop2', data: { host: '127.0.0.2' } },
      );
      assert.equal(seeded.status, 200, JSON.stringify(seeded));
      assert.equal(seeded.body.ok, true, JSON.stringify(seeded));
      return { hostProc: proc, pointer: parsed };
    },
  );

  await app.step('CLI discovery and mounted /__pyric/mcp reach 127.0.0.2 quickly with projectDir stamped', async () => {
    const started = Date.now();
    const read = await app.pyric(['firestore', 'getDoc', '--path', 'items/loop2', '--json']);
    const elapsedMs = Date.now() - started;
    assert.equal(read.code, 0, read.output);
    assert.ok(read.output.includes('127.0.0.2'), read.output);
    const cliResult = parseCliJson(read.output) as {
      ok?: boolean;
      data?: { exists?: boolean };
    };
    assert.equal(cliResult.data?.exists, true, read.output);
    assert.ok(elapsedMs < 8_000, `expected fast 127.0.0.2 discovery, took ${elapsedMs}ms`);

    const mcpHeaders: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (pointer.token) mcpHeaders['x-pyric-session-token'] = pointer.token;
    const mcpUrl = pointer.mcpUrl ?? `${pointer.url}/__pyric/mcp`;
    const initRes = await fetch(mcpUrl, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mounted-probe', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const initJson = parseSseOrJson(await initRes.text()) as { result?: { instructions?: string } };
    assert.ok(initJson.result?.instructions?.includes(realProject), JSON.stringify(initJson));
    assert.ok(!/no Firebase or Pyric project markers/i.test(initJson.result?.instructions ?? ''));
  });

  await app.step('pyric mcp attaches to 127.0.0.2 host, falls back after host stop, and persists writes across sessions', async () => {
    const triggerFile = join(unrelatedCwd, 'host-stopped.signal');
    const mcpProc = app.commandProcess('node', ['probe-mcp-fallback.mjs', cliPath, app.dir, triggerFile]);
    await mcpProc.waitForLog(/^ready \{/m, { timeoutMs: 30_000 });
    const readyLine = mcpProc.output.split('\n').find((entry) => entry.startsWith('ready '));
    assert.ok(readyLine, mcpProc.output);
    const readyPayload = JSON.parse(readyLine.slice('ready '.length)) as {
      onHostBody: { ok?: boolean; data?: { exists?: boolean }; _pyric?: { target?: string } };
    };
    assert.equal(readyPayload.onHostBody._pyric?.target, 'host', readyLine);
    assert.equal(readyPayload.onHostBody.data?.exists, true, readyLine);

    await hostProc.stop();
    writeFileSync(triggerFile, 'stopped\n', 'utf8');

    await mcpProc.waitForLog(/^result \{/m, { timeoutMs: 30_000 });
    const resultLine = mcpProc.output.split('\n').find((entry) => entry.startsWith('result '));
    assert.ok(resultLine, mcpProc.output);
    const resultPayload = JSON.parse(resultLine.slice('result '.length)) as {
      exitCode: number | null;
      deadHostBody: { ok?: boolean; _pyric?: { target?: string } };
      fallbackBody: { ok?: boolean; summary?: string; _pyric?: { target?: string } };
    };
    assert.equal(resultPayload.deadHostBody.ok, false);
    assert.equal(resultPayload.deadHostBody._pyric?.target, 'host');
    assert.equal(resultPayload.fallbackBody.ok, true);
    assert.equal(resultPayload.fallbackBody._pyric?.target, 'in-process');
    assert.ok(resultPayload.fallbackBody.summary?.includes('The sandbox host stopped.'));
    assert.equal(resultPayload.exitCode, 0);
    await mcpProc.stop();

    assert.equal(existsSync(join(app.dir, '.pyric', 'state', 'in-process.json')), true);

    const nextRead = await app.pyric(['firestore', 'getDoc', '--path', 'items/after-stop', '--json']);
    assert.equal(nextRead.code, 0, nextRead.output);
    const nextJson = parseCliJson(nextRead.output) as { data?: { exists?: boolean } };
    assert.equal(nextJson.data?.exists, true, nextRead.output);
  });
});
