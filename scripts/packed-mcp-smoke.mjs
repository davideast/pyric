#!/usr/bin/env node

/**
 * Drive an installed `pyric mcp` binary over its real stdio protocol.
 * This deliberately speaks JSON-RPC directly so the packaging gate does not
 * borrow the server's MCP SDK dependency as its client implementation.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GOOD_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resultPayload(response, name) {
  if (response.error) {
    throw new Error(`${name} returned JSON-RPC error: ${JSON.stringify(response.error)}`);
  }
  const text = response.result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(`${name} returned no MCP text content: ${JSON.stringify(response)}`);
  }
  return JSON.parse(text);
}

export async function runPackedMcpSmoke({
  bin,
  workDir,
  expectedToolNames,
  quiet = false,
}) {
  const executable = isAbsolute(bin) ? bin : resolve(bin);
  const cwd = isAbsolute(workDir) ? workDir : resolve(workDir);
  mkdirSync(join(cwd, '.pyric'), { recursive: true });

  // An identity-bearing stale pointer makes discovery deterministically choose
  // headless mode without blindly scanning into an unrelated developer server.
  writeFileSync(
    join(cwd, '.pyric', 'serve.json'),
    `${JSON.stringify({
      port: 65_534,
      instanceId: 'packed-mcp-smoke-intentionally-absent',
    })}\n`,
  );

  const child = spawn(executable, ['mcp'], {
    cwd,
    env: { ...process.env, CI: '1', HOME: cwd, USERPROFILE: cwd },
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        continue;
      }
      if (message.id == null) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      const error = new Error(
        `pyric mcp exited before completing (code=${code}, signal=${signal})\nstderr:\n${stderr}`,
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      resolveExit({ code, signal });
    });
  });

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = async (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    send({ jsonrpc: '2.0', id, method, params });
    return await withTimeout(response, 10_000, `MCP ${method}`);
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pyric-packed-smoke', version: '1' },
    });
    if (initialized.error || initialized.result?.serverInfo?.name !== 'pyric') {
      throw new Error(`pyric mcp initialize failed: ${JSON.stringify(initialized)}`);
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    const listed = await request('tools/list');
    const toolNames = listed.result?.tools?.map((tool) => tool.name);
    const actualSorted = [...(toolNames ?? [])].sort();
    const expectedSorted = [...expectedToolNames].sort();
    if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
      throw new Error(
        `packed pyric mcp tool contract drifted\n` +
          `expected: ${expectedToolNames.join(', ')}\n` +
          `actual:   ${(toolNames ?? []).join(', ')}`,
      );
    }

    const localCall = resultPayload(
      await request('tools/call', {
        name: 'firestore_lint_rules',
        arguments: { source: GOOD_RULES },
      }),
      'firestore_lint_rules',
    );
    if (!localCall.ok) throw new Error(`local MCP call failed: ${JSON.stringify(localCall)}`);

    const sandboxCall = resultPayload(
      await request('tools/call', { name: 'sandbox_inspect', arguments: {} }),
      'sandbox_inspect',
    );
    if (!sandboxCall.ok) {
      throw new Error(`sandbox MCP call failed: ${JSON.stringify(sandboxCall)}`);
    }

    child.stdin.end();
    const exit = await withTimeout(exited, 5_000, 'pyric mcp shutdown');
    if (exit.code !== 0) {
      throw new Error(`pyric mcp exited ${exit.code}\nstderr:\n${stderr}`);
    }

    if (!quiet) {
      process.stdout.write(
        `  ✓ packed pyric mcp initialized, listed ${toolNames.length} tools, and executed local + sandbox calls\n`,
      );
    }
    return { toolNames, localCall, sandboxCall };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [bin, workDir, contractPath] = process.argv.slice(2);
  if (!bin || !workDir || !contractPath) {
    process.stderr.write(
      'usage: node scripts/packed-mcp-smoke.mjs <pyric-bin> <work-dir> <release-contract.json>\n',
    );
    process.exit(2);
  }
  const contract = JSON.parse(readFileSync(resolve(contractPath), 'utf8'));
  await runPackedMcpSmoke({
    bin,
    workDir,
    expectedToolNames: contract.mcpTools,
  });
}
