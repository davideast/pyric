// Exercises standalone HTTP bridge Host validation and projectDir stamping
// from an unrelated working directory using the installed @pyric/cli package.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { startServer } from '@pyric/cli/bridge';

const [projectDirArg, otherCwdArg] = process.argv.slice(2);
const projectDir = resolve(projectDirArg);
const otherCwd = resolve(otherCwdArg);
const realProjectDir = realpathSync(projectDir);

function sendRawHttp(port, rawRequest, timeoutMs = 1500) {
  return new Promise((resolveReq) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let data = '';
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      let statusLine = null;
      if (data.length > 0) statusLine = data.split('\r\n')[0];
      const match = statusLine?.match(/^HTTP\/\d\.\d\s+(\d{3})\b/);
      let statusCode = null;
      if (match) statusCode = Number(match[1]);
      resolveReq({ timedOut, statusCode, statusLine });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.on('connect', () => socket.write(rawRequest));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  throw new Error(`Unparseable MCP response: ${text}`);
}

async function callHttpMcp(url, body, sessionId = null) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP MCP ${res.status}: ${text}`);
  let json = null;
  if (text.trim()) json = parseSseOrJson(text);
  return {
    sessionId: res.headers.get('mcp-session-id') ?? sessionId,
    json,
  };
}

const rejections = [];
const onRejection = (err) => {
  if (err instanceof Error) {
    rejections.push(`${err.name}: ${err.message}`);
  } else {
    rejections.push(String(err));
  }
};
process.on('unhandledRejection', onRejection);

const origCwd = process.cwd();
process.chdir(otherCwd);

const server = await startServer({
  port: 0,
  projectDir,
  disableAuditLog: true,
  silent: true,
});

try {
  const okBefore = await sendRawHttp(
    server.port,
    `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
  );
  assert.equal(okBefore.timedOut, false);
  assert.equal(okBefore.statusCode, 200);

  for (const badHost of ['[::1', 'bad host', '']) {
    const res = await sendRawHttp(
      server.port,
      `GET /health HTTP/1.1\r\nHost: ${badHost}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(res.timedOut, false, `timed out on Host=${JSON.stringify(badHost)}`);
    assert.ok(
      res.statusCode === 400 || res.statusCode === 403,
      `expected 400/403 for Host=${JSON.stringify(badHost)}, got ${res.statusCode}`,
    );
  }

  const okAfter = await sendRawHttp(
    server.port,
    `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
  );
  assert.equal(okAfter.timedOut, false);
  assert.equal(okAfter.statusCode, 200);
  assert.deepEqual(rejections, []);

  const init = await callHttpMcp(server.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'bridge-probe', version: '1.0.0' },
    },
  });
  await callHttpMcp(
    server.mcpUrl,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    init.sessionId,
  );
  const call = await callHttpMcp(
    server.mcpUrl,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'auth_whoami', arguments: {} } },
    init.sessionId,
  );
  const payload = JSON.parse(call.json.result.content[0].text);
  const instructions = init.json.result.instructions ?? '';

  process.stdout.write(
    `bridge-probe ${JSON.stringify({
      realProjectDir,
      stampedProjectDir: payload._pyric?.projectDir ?? null,
      isProject: payload._pyric?.isProject ?? null,
      instructionsHasProjectDir: instructions.includes(realProjectDir),
      warnsNoMarkers: /no Firebase or Pyric project markers/i.test(instructions),
    })}\n`,
  );
} finally {
  process.off('unhandledRejection', onRejection);
  process.chdir(origCwd);
  await server.stop();
}
