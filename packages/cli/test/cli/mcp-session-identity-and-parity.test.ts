/**
 * Standing check for MCP project identity and start-order tool-list parity.
 *
 * Drives the built `pyric mcp` CLI over stdio across:
 *   {started before host, started after host}
 *     x {cwd in project, cwd outside, --project-dir <project>}
 *
 * Every cell must advertise the exact 10-tool product surface
 * (`DEFAULT_MCP_TOOL_NAMES`), name its resolved project directory and target
 * in `initialize.instructions` (warning when no project markers exist), and
 * stamp `_pyric.{projectDir, isProject, target}` onto every tool result.
 */
import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_MCP_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const EXPECTED_TOOLS = [...DEFAULT_MCP_TOOL_NAMES].sort();

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpSession {
  started: boolean;
  exitCode?: number | null;
  init?: Record<string, unknown>;
  stderr(): string;
  listTools(): Promise<string[]>;
  callDatabaseGet(path: string): Promise<{
    raw: Record<string, unknown>;
    body: {
      ok: boolean;
      summary: string;
      data?: { exists?: boolean; value?: unknown };
      _pyric?: {
        mode?: string;
        project?: string;
        target?: string;
        projectDir?: string;
        isProject?: boolean;
      };
    };
  }>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function openMcpSession(cwd: string, args: string[]): Promise<McpSession> {
  const child: ChildProcessWithoutNullStreams = spawn('node', [CLI_ENTRY, 'mcp', ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  let exitCode: number | null | undefined;
  const exited = new Promise<{ exited: number | null }>((r) => {
    child.once('exit', (code) => {
      exitCode = code;
      r({ exited: code });
    });
  });

  const waiting = new Map<number, (msg: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) {
        const resolver = waiting.get(message.id);
        if (resolver !== undefined) {
          waiting.delete(message.id);
          resolver(message);
        }
      }
    }
  });

  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse | { exited: number | null } | { timedOut: true }> => {
    nextId += 1;
    const id = nextId;
    const answer = new Promise<JsonRpcResponse>((r) => waiting.set(id, r));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return Promise.race([answer, exited, sleep(20_000).then(() => ({ timedOut: true as const }))]);
  };

  const close = async (): Promise<void> => {
    if (exitCode !== undefined) return;
    child.stdin.end();
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    if (exitCode === undefined) {
      child.kill('SIGKILL');
      await Promise.race([exited, sleep(1_000)]);
    }
  };

  const init = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-matrix-test', version: '0' },
  });
  if (!('result' in init) || init.result === undefined) {
    await close();
    let failedExitCode = exitCode;
    if ('exited' in init) {
      failedExitCode = init.exited;
    }
    return {
      started: false,
      exitCode: failedExitCode,
      stderr: () => stderr,
      listTools: async () => [],
      callDatabaseGet: async () => {
        throw new Error('session did not start');
      },
      close,
    };
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    started: true,
    init: init.result,
    stderr: () => stderr,
    async listTools(): Promise<string[]> {
      const response = await request('tools/list', {});
      if (!('result' in response) || response.result === undefined) {
        throw new Error(`tools/list failed: ${JSON.stringify(response)}`);
      }
      const tools = (response.result.tools as Array<{ name: string }> | undefined) ?? [];
      return tools.map((tool) => tool.name).sort();
    },
    async callDatabaseGet(path: string) {
      const response = await request('tools/call', {
        name: 'database',
        arguments: { method: 'get', args: { path } },
      });
      if (!('result' in response) || response.result === undefined) {
        throw new Error(`tools/call failed: ${JSON.stringify(response)}`);
      }
      const content = (response.result.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
      const text = content.find((entry) => entry.type === 'text')?.text ?? '';
      return {
        raw: response.result,
        body: JSON.parse(text),
      };
    },
    close,
  };
}

describe('pyric mcp project identity and start-order tool parity', () => {
  it('serves identical 10-tool surface and project identity across the 2x3 start-order x cwd matrix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-mcp-matrix-'));
    const project = join(root, 'project');
    const elsewhereA = join(root, 'elsewhere-before');
    const elsewhereB = join(root, 'elsewhere-after');
    mkdirSync(project);
    mkdirSync(elsewhereA);
    mkdirSync(elsewhereB);
    writeFileSync(join(project, 'package.json'), '{"name":"project","private":true}\n');
    writeFileSync(join(project, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));

    const realProject = realpathSync(project);
    const realElsewhereA = realpathSync(elsewhereA);
    const realElsewhereB = realpathSync(elsewhereB);

    let host: ReturnType<typeof spawn> | undefined;
    const sessions: McpSession[] = [];
    const track = (session: McpSession): McpSession => {
      sessions.push(session);
      return session;
    };

    try {
      // Start all three "before host" sessions before any Node host exists.
      const beforeInProject = track(await openMcpSession(project, []));
      const beforeOutside = track(await openMcpSession(elsewhereA, []));
      expect(beforeInProject.started).toBe(true);
      expect(beforeOutside.started).toBe(true);
      expect(await beforeInProject.listTools()).toEqual(EXPECTED_TOOLS);
      expect(await beforeOutside.listTools()).toEqual(EXPECTED_TOOLS);

      // Verify initialize.instructions before host starts.
      const beforeInProjectInstructions = String(beforeInProject.init?.instructions ?? '');
      expect(beforeInProjectInstructions).toContain(realProject);
      expect(beforeInProjectInstructions).toContain('in-process');

      const beforeOutsideInstructions = String(beforeOutside.init?.instructions ?? '');
      expect(beforeOutsideInstructions).toContain(realElsewhereA);
      expect(beforeOutsideInstructions).toContain('in-process');
      expect(beforeOutsideInstructions).toMatch(/no project|project marker|--project-dir/i);

      // Close before-in-project cleanly only after checking it follows the host once started.
      host = spawn('node', [CLI_ENTRY, 'sandbox', '--hosted', '--no-open'], {
        cwd: project,
        stdio: 'ignore',
      });
      const pointer = join(project, '.pyric', 'serve.json');
      for (let i = 0; i < 150 && !existsSync(pointer); i += 1) await sleep(200);
      expect(existsSync(pointer)).toBe(true);

      const write = spawnSync(
        'node',
        [CLI_ENTRY, 'database', 'set', '--path', 'items/a', '--value', '{"n":1}'],
        { cwd: project, encoding: 'utf8', timeout: 30_000 },
      );
      expect(write.status).toBe(0);

      // Let TargetRouter's 1s pointer cache expire.
      await sleep(1_200);

      // Cell 1: started before host, cwd in project -> follows host.
      const cell1 = await beforeInProject.callDatabaseGet('items/a');
      expect(await beforeInProject.listTools()).toEqual(EXPECTED_TOOLS);
      expect(cell1.body.ok).toBe(true);
      expect(cell1.body.data?.value).toEqual({ n: 1 });
      expect(cell1.body._pyric?.target).toBe('host');
      expect(cell1.body._pyric?.projectDir).toBe(realProject);
      expect(cell1.body._pyric?.isProject).toBe(true);

      // Cell 2: started before host, cwd outside -> stays in-process and names its dir.
      const cell2 = await beforeOutside.callDatabaseGet('items/a');
      expect(await beforeOutside.listTools()).toEqual(EXPECTED_TOOLS);
      expect(cell2.body.ok).toBe(true);
      expect(cell2.body.data?.exists).toBe(false);
      expect(cell2.body._pyric?.target).toBe('in-process');
      expect(cell2.body._pyric?.projectDir).toBe(realElsewhereA);
      expect(cell2.body._pyric?.isProject).toBe(false);

      // Close beforeInProject before starting after-host sessions.
      await beforeInProject.close();
      await beforeOutside.close();

      // Cell 3: started before host, outside cwd with --project-dir (test against a fresh project).
      const project2 = join(root, 'project-before-dir');
      mkdirSync(project2);
      writeFileSync(join(project2, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
      const realProject2 = realpathSync(project2);
      const beforeWithProjectDir = track(await openMcpSession(elsewhereA, ['--project-dir', project2]));
      expect(beforeWithProjectDir.started).toBe(true);
      expect(await beforeWithProjectDir.listTools()).toEqual(EXPECTED_TOOLS);
      expect(String(beforeWithProjectDir.init?.instructions ?? '')).toContain(realProject2);
      const cell3Before = await beforeWithProjectDir.callDatabaseGet('items/a');
      expect(cell3Before.body._pyric?.projectDir).toBe(realProject2);
      expect(cell3Before.body._pyric?.isProject).toBe(true);
      expect(cell3Before.body._pyric?.target).toBe('in-process');
      await beforeWithProjectDir.close();

      // Cell 4: started after host, cwd in project -> identical 10 tools and reads host.
      const afterInProject = track(await openMcpSession(project, []));
      expect(afterInProject.started).toBe(true);
      expect(await afterInProject.listTools()).toEqual(EXPECTED_TOOLS);
      const afterInProjectInstructions = String(afterInProject.init?.instructions ?? '');
      expect(afterInProjectInstructions).toContain(realProject);
      expect(afterInProjectInstructions).toContain('host');
      const cell4 = await afterInProject.callDatabaseGet('items/a');
      expect(cell4.body.ok).toBe(true);
      expect(cell4.body.data?.value).toEqual({ n: 1 });
      expect(cell4.body._pyric?.target).toBe('host');
      expect(cell4.body._pyric?.projectDir).toBe(realProject);
      expect(cell4.body._pyric?.isProject).toBe(true);

      // Cell 5: started after host, cwd outside -> identical 10 tools, in-process, isProject=false.
      const afterOutside = track(await openMcpSession(elsewhereB, []));
      expect(afterOutside.started).toBe(true);
      expect(await afterOutside.listTools()).toEqual(EXPECTED_TOOLS);
      const afterOutsideInstructions = String(afterOutside.init?.instructions ?? '');
      expect(afterOutsideInstructions).toContain(realElsewhereB);
      expect(afterOutsideInstructions).toContain('in-process');
      expect(afterOutsideInstructions).toMatch(/no project|project marker|--project-dir/i);
      const cell5 = await afterOutside.callDatabaseGet('items/a');
      expect(cell5.body.ok).toBe(true);
      expect(cell5.body.data?.exists).toBe(false);
      expect(cell5.body._pyric?.target).toBe('in-process');
      expect(cell5.body._pyric?.projectDir).toBe(realElsewhereB);
      expect(cell5.body._pyric?.isProject).toBe(false);

      // Cell 6: started after host, cwd outside with --project-dir -> identical 10 tools and reads host.
      // Opened concurrently while afterInProject is still open, verifying no in-process lock collision!
      const afterWithProjectDir = track(await openMcpSession(elsewhereB, ['--project-dir', project]));
      expect(afterWithProjectDir.started).toBe(true);
      expect(await afterWithProjectDir.listTools()).toEqual(EXPECTED_TOOLS);
      const afterWithProjectDirInstructions = String(afterWithProjectDir.init?.instructions ?? '');
      expect(afterWithProjectDirInstructions).toContain(realProject);
      expect(afterWithProjectDirInstructions).toContain('host');
      const cell6 = await afterWithProjectDir.callDatabaseGet('items/a');
      expect(cell6.body.ok).toBe(true);
      expect(cell6.body.data?.value).toEqual({ n: 1 });
      expect(cell6.body._pyric?.target).toBe('host');
      expect(cell6.body._pyric?.projectDir).toBe(realProject);
      expect(cell6.body._pyric?.isProject).toBe(true);

      // Guardrail: --attach outside the project still refuses cleanly.
      const attachOutside = track(await openMcpSession(elsewhereB, ['--attach']));
      expect(attachOutside.started).toBe(false);
      expect(attachOutside.exitCode).toBe(1);
    } finally {
      await Promise.allSettled(sessions.map((session) => session.close()));
      host?.kill('SIGTERM');
      await sleep(300);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
