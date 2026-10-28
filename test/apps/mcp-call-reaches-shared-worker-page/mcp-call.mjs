// An agent's editor runs `pyric mcp` over stdio. This script is that editor:
// it starts the installed `pyric mcp --attach`, initializes, calls one tool,
// and prints the tool's result as `result <json>`.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [name, argsJson] = process.argv.slice(2);
const cli = join('node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
const child = spawn(process.execPath, [cli, 'mcp', '--attach'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

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
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const timer = setTimeout(() => {
  process.stderr.write('pyric mcp did not answer within 30s\n');
  child.kill();
  process.exit(1);
}, 30_000);

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-call-reaches-shared-worker-page', version: '0' },
});
if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
notify('notifications/initialized', {});
const call = await request('tools/call', { name, arguments: JSON.parse(argsJson) });
clearTimeout(timer);
if (call.error) throw new Error(`tools/call failed: ${JSON.stringify(call.error)}`);
const text = call.result.content.find((block) => block.type === 'text')?.text ?? '';
process.stdout.write(`result ${JSON.stringify({ isError: call.result.isError === true, body: JSON.parse(text) })}\n`);
child.stdin.end();
child.kill();
