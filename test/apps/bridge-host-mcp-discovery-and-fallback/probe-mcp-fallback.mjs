// Drives an installed `pyric mcp` stdio session that starts against a running
// host, verifies initial host routing, waits for a trigger file while the host
// stops, then writes after fallback and closes cleanly.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [cliPath, projectDir, triggerFile] = process.argv.slice(2);
const child = spawn(process.execPath, [resolve(cliPath), 'mcp', '--project-dir', resolve(projectDir)], {
  cwd: resolve(projectDir),
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += String(chunk);
  let idx = buf.indexOf('\n');
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf('\n');
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      done(msg);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolveReq, rejectReq) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectReq(new Error(`Timed out on ${method}\nstderr:\n${stderr}`));
    }, 20_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolveReq(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const exited = new Promise((resolveExit) => {
  child.once('exit', (code) => resolveExit(code));
});

try {
  await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'fallback-probe', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const onHost = await request('tools/call', {
    name: 'firestore',
    arguments: { method: 'getDoc', args: { path: 'items/loop2' } },
  });
  const onHostBody = JSON.parse(onHost.result.content[0].text);
  process.stdout.write(`ready ${JSON.stringify({ onHostBody })}\n`);

  const deadline = Date.now() + 30_000;
  while (!existsSync(triggerFile)) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for stop trigger');
    await new Promise((r) => setTimeout(r, 100));
  }

  const deadHostCall = await request('tools/call', {
    name: 'firestore',
    arguments: { method: 'setDoc', args: { path: 'items/dead-call', data: { step: 1 } } },
  });
  const deadHostBody = JSON.parse(deadHostCall.result.content[0].text);

  const fallbackWrite = await request('tools/call', {
    name: 'firestore',
    arguments: { method: 'setDoc', args: { path: 'items/after-stop', data: { persisted: true } } },
  });
  const fallbackBody = JSON.parse(fallbackWrite.result.content[0].text);

  child.stdin.end();
  const exitCode = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  process.stdout.write(
    `result ${JSON.stringify({ exitCode, deadHostBody, fallbackBody })}\n`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
}
