/**
 * `pyric call <tool> <op>` against a real `pyric sandbox --bridge` and the
 * headless fallback.
 *
 * The attached path starts a serve with the bridge mounted, connects a Node
 * peer that dispatches forwarded operations against a real sandbox (the same
 * shape `test/bridge/e2e.test.ts` uses), and drives `runCall` with discovery
 * pointed at that project directory. The headless path injects a discovery
 * that finds nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { initializeSandbox } from 'pyric/sandbox';
import { dispatchSandboxTool, SANDBOX_OP_KEYS } from '../../src/bridge/client/dispatch.js';
import { isBridgeMessage } from '../../src/bridge/protocol.js';
import { runCall, type CallDeps } from '../../src/cli/call.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{doc=**} { allow read, write: if true; }
  }
}`;

/** Passes the linter: no open recursive wildcard. */
const STRICT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == request.resource.data.author;
    }
  }
}`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-call-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>p</body></html>');
  return dir;
}

/** A Node-side sandbox peer on the serve's `/__pyric/sandbox` socket. */
function connectPeer(port: number): Promise<() => void> {
  const sandbox = initializeSandbox();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__pyric/sandbox`);
  return new Promise((resolve, reject) => {
    let acked = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, tools: [...SANDBOX_OP_KEYS], sandboxId: 'call-test' }));
    });
    ws.on('message', async (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isBridgeMessage(msg)) return;
      if (msg.type === 'hello-ack' && !acked) {
        acked = true;
        resolve(() => ws.close());
        return;
      }
      if (msg.type === 'tool-call') {
        try {
          const result = await dispatchSandboxTool(sandbox, msg.name, msg.op, msg.args ?? {});
          ws.send(JSON.stringify({ type: 'tool-result', id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'tool-result',
              id: msg.id,
              ok: false,
              error: { code: 'Error', message: err instanceof Error ? err.message : String(err) },
            }),
          );
        }
      }
    });
    ws.on('error', (err) => {
      if (!acked) reject(err);
    });
  });
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function call(args: string[], deps: CallDeps = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runCall(parseArgs(['call', ...args]), {
    scanPorts: [],
    stdout: { write: (s: string) => void (stdout += s) },
    stderr: { write: (s: string) => void (stderr += s) },
    ...deps,
  });
  return { code, stdout, stderr };
}

const noSandbox: CallDeps = { discover: async () => null };

describe('pyric call', () => {
  let cwd: string;
  let serve: ServeRuntime;
  let disconnectPeer: () => void;

  beforeAll(async () => {
    cwd = project();
    serve = await startServe({
      cwd,
      port: 0,
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    disconnectPeer = await connectPeer(serve.handle.port);
  }, 30_000);

  afterAll(async () => {
    disconnectPeer();
    await serve.handle.stop();
  });

  it('runs a forwarded op with --args against the sandbox found through the pointer', async () => {
    const seeded = await call(
      ['firestore_simulator', 'create', '--args', JSON.stringify({ rules: RULES, documents: { 'users/u1': { name: 'Alice' } } })],
      { cwd },
    );
    expect(seeded.stderr).toBe('');
    expect(seeded.code).toBe(0);

    const read = await call(
      ['firestore_data', 'get', '--args', JSON.stringify({ path: 'users/u1' }), '--json'],
      { cwd },
    );
    expect(read.stderr).toBe('');
    expect(read.code).toBe(0);
    expect(read.stdout.trim().split('\n')).toHaveLength(1);
    const envelope = JSON.parse(read.stdout) as { ok: boolean; data: { data: unknown }; _pyric: { mode: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.data).toEqual({ name: 'Alice' });
    expect(envelope._pyric.mode).toBe('sandbox');
  }, 30_000);

  it('reaches the sandbox by --port and pretty-prints by default', async () => {
    const result = await call(['sandbox', 'inspect', '--port', String(serve.handle.port)], {
      cwd: mkdtempSync(join(tmpdir(), 'pyric-call-elsewhere-')),
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n').length).toBeGreaterThan(2);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  it('runs an in-process op with --stdin against the headless surface when no sandbox runs', async () => {
    const result = await call(['firestore_rules', 'lint', '--stdin'], {
      ...noSandbox,
      readStdin: async () => JSON.stringify({ source: STRICT_RULES }),
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; summary: string };
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.summary).toBe('string');
  }, 30_000);

  it('rejects an unknown op with exit 1 and the valid ops listed', async () => {
    const result = await call(['firestore_rules', 'deploy'], noSandbox);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown op 'deploy' for firestore_rules");
    expect(result.stderr).toContain('valid ops: lint, simulate, resolve, validate, test');
  });

  it('rejects an unknown tool, malformed JSON, and a JSON op field with exit 1', async () => {
    const tool = await call(['firestore_docs', 'get'], noSandbox);
    expect(tool.code).toBe(1);
    expect(tool.stderr).toContain("unknown tool 'firestore_docs'");
    expect(tool.stderr).toContain('firestore_data');

    const json = await call(['firestore_rules', 'lint', '--args', '{not json'], noSandbox);
    expect(json.code).toBe(1);
    expect(json.stderr).toContain('failed to parse --args JSON');

    const op = await call(['firestore_rules', 'lint', '--args', '{"op":"lint","source":""}'], noSandbox);
    expect(op.code).toBe(1);
    expect(op.stderr).toContain("do not also pass 'op'");
  });

  it('prints the structured envelope on stderr and exits 2 for invalid fields', async () => {
    const result = await call(['firestore_rules', 'lint', '--args', '{"testCases":[]}', '--json'], { cwd });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const envelope = JSON.parse(result.stderr) as { ok: boolean; summary: string; data: Record<string, unknown> };
    expect(envelope.ok).toBe(false);
    expect(envelope.summary).toBe(
      "firestore_rules.lint: invalid fields: 'source' is required; 'testCases' is not a field of op 'lint'",
    );
    expect(envelope.data).toMatchObject({ error: 'invalid_fields', tool: 'firestore_rules', op: 'lint' });
  }, 30_000);

  it('exits 2 with a one-line message for a forwarded op when no sandbox runs', async () => {
    const result = await call(['firestore_data', 'get', '--args', '{"path":"users/u1"}'], noSandbox);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('firestore_data.get');
    expect(result.stderr).toContain('pyric sandbox --bridge');
  });
});
