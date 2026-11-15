// Drives one installed `pyric mcp` session over stdio from a chosen cwd,
// prints `probe <json>` with initialize result, listed tool names, and a
// `database.get` result for `items/a`. When `--wait-file=<path>` is passed,
// waits for that file to appear before calling `tools/list` and `tools/call`
// so the parent scenario can start the Node host in between.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const rawArgs = process.argv.slice(2);
const waitFlag = rawArgs.find((arg) => arg.startsWith('--wait-file='));
let waitFile = null;
if (waitFlag) {
  waitFile = waitFlag.slice('--wait-file='.length);
}
const filtered = rawArgs.filter((arg) => !arg.startsWith('--wait-file='));
const [cliPath, workDir, ...mcpArgs] = filtered;
const child = spawn(process.execPath, [resolve(cliPath), 'mcp', ...mcpArgs], {
  cwd: resolve(workDir),
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const waiting = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += String(chunk);
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    const message = JSON.parse(line);
    const resolveWait = waiting.get(message.id);
    if (resolveWait) {
      waiting.delete(message.id);
      resolveWait(message);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolveReq) => waiting.set(id, resolveReq));
}

const exited = new Promise((resolveExit) => {
  child.once('exit', (code) => resolveExit({ exited: code }));
});

const init = await Promise.race([
  request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-session-names-its-sandbox', version: '0' },
  }),
  exited,
]);

if (!init.result) {
  process.stdout.write(`probe ${JSON.stringify({ started: false, exitCode: init.exited ?? null, stderr })}\n`);
  process.exit(0);
}

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

if (waitFile) {
  process.stdout.write(`ready ${JSON.stringify({ init: init.result })}\n`);
  const deadline = Date.now() + 60_000;
  while (!existsSync(waitFile)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for trigger file ${waitFile}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const list = await request('tools/list', {});
const tools = (list.result?.tools ?? []).map((tool) => tool.name).sort();
const call = await request('tools/call', {
  name: 'database',
  arguments: { method: 'get', args: { path: 'items/a' } },
});
const text = call.result?.content?.find((block) => block.type === 'text')?.text ?? '';
let body = null;
try {
  body = JSON.parse(text);
} catch {
  body = { rawText: text };
}

process.stdout.write(
  `probe ${JSON.stringify({ started: true, init: init.result, tools, isError: call.result?.isError === true, body })}\n`,
);
child.stdin.end();
child.kill('SIGTERM');
await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
