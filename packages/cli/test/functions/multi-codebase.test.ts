/**
 * Unit and runtime-coordination tests for multi-codebase `firebase.json` support:
 *  - `extractFunctionsCodebases` validation (single object, single/multi arrays, empty array,
 *    invalid/duplicate codebase names, missing/invalid/duplicate sources).
 *  - `discoverFunctionsProjects` / `discoverFunctionsProject` (partial builds, resolved path
 *    collisions, codebase metadata, legacy single-object backward compatibility).
 *  - `createFunctionsDevelopmentRuntime` multi-codebase coordination (isolated children,
 *    duplicate export guards across HTTP/callable/event/unsupported triggers, clean teardown,
 *    codebase-tagged events/logs/listings, reload, per-codebase crash restart).
 *  - `createFunctionsHttpGateway` routing across multiple codebase backends (emulator paths,
 *    Hosting rewrites, region disambiguation, 404 listing, codebase execution logs).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DEFAULT_FUNCTIONS_CODEBASE,
  extractFunctionsCodebases,
} from '../../src/cli/firebase-json.js';
import type { FunctionsChildReady } from '../../src/functions/child-protocol.js';
import {
  createFunctionsDevelopmentRuntime,
  type FunctionsDevelopmentEvent,
  type FunctionsPeerReadiness,
} from '../../src/functions/development-runtime.js';
import { listExecutions, recordFunctionExecution } from '../../src/functions/execution-log.js';
import {
  functionsTriggersLine,
  httpFunctionLines,
  servedLine,
} from '../../src/functions/http/report.js';
import {
  findDuplicateCodebaseExports,
  formatDuplicateCodebaseExportsError,
} from '../../src/functions/multi-codebase-runtime.js';
import {
  codebasesOfFunctionsProject,
  discoverFunctionsProject,
  discoverFunctionsProjects,
  type FunctionsCodebaseProject,
} from '../../src/functions/project.js';
import type {
  FunctionsChildHandle,
  SpawnFunctionsChildOptions,
} from '../../src/functions/spawn.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const tempDirs = trackTempDirs('pyric-multi-codebase-unit-');

afterEach(() => {
  tempDirs.cleanupTempDirs();
});

function createFakeChildHandle(
  readyResult: FunctionsChildReady | Error,
  options: {
    onStop?: () => void;
    stdoutText?: string;
  } = {},
): {
  handle: FunctionsChildHandle;
  emitExit: (code: number) => void;
  stopped: () => boolean;
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  (child as unknown as { stdout: PassThrough; stderr: PassThrough }).stdout = stdout;
  (child as unknown as { stdout: PassThrough; stderr: PassThrough }).stderr = stderr;

  let isStopped = false;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((res) => {
    resolveExit = res;
  });

  if (options.stdoutText !== undefined) {
    stdout.write(options.stdoutText);
  }

  const ready =
    readyResult instanceof Error ? Promise.reject(readyResult) : Promise.resolve(readyResult);
  ready.catch(() => undefined);

  return {
    handle: {
      child,
      ready,
      exited,
      async stop(): Promise<number> {
        if (!isStopped) {
          isStopped = true;
          options.onStop?.();
          stdout.end();
          stderr.end();
          resolveExit(0);
        }
        return exited;
      },
    },
    emitExit(code: number) {
      resolveExit(code);
    },
    stopped: () => isStopped,
  };
}

function createCodebaseFixture(
  root: string,
  subdir: string,
  options: { main?: string; built?: boolean } = {},
): { sourceDir: string; entry: string } {
  const sourceDir = join(root, subdir);
  mkdirSync(sourceDir, { recursive: true });
  const pkg: Record<string, unknown> = { name: subdir };
  if (options.main !== undefined) pkg.main = options.main;
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify(pkg));
  const main = options.main ?? 'index.js';
  const entry = join(sourceDir, main);
  if (options.built !== false) {
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, 'exports.noop = true;\n');
  }
  return { sourceDir, entry };
}

describe('extractFunctionsCodebases (firebase.json parsing & validation)', () => {
  test('normalizes single object, single-element array, multi-codebase array, and empty array', () => {
    expect(extractFunctionsCodebases(null)).toEqual([]);
    expect(extractFunctionsCodebases({})).toEqual([]);
    expect(extractFunctionsCodebases({ functions: [] })).toEqual([]);

    expect(extractFunctionsCodebases({ functions: {} })).toEqual([
      { codebase: DEFAULT_FUNCTIONS_CODEBASE, source: 'functions' },
    ]);
    expect(extractFunctionsCodebases({ functions: { source: 'api', codebase: 'api', runtime: 'nodejs22' } })).toEqual([
      { codebase: 'api', source: 'api', runtime: 'nodejs22' },
    ]);
    expect(
      extractFunctionsCodebases({
        functions: [
          { codebase: 'a', source: 'functions-a' },
          { codebase: 'b', source: 'functions-b' },
        ],
      }),
    ).toEqual([
      { codebase: 'a', source: 'functions-a' },
      { codebase: 'b', source: 'functions-b' },
    ]);
  });

  test('rejects malformed entries, invalid codebase names, missing sources, and duplicate codebases/sources', () => {
    expect(() => extractFunctionsCodebases({ functions: 'bad' })).toThrow(/object or an array/);
    expect(() => extractFunctionsCodebases({ functions: [null] })).toThrow(/functions\[0\]/);
    expect(() => extractFunctionsCodebases({ functions: [[]] })).toThrow(/functions\[0\]/);
    expect(() =>
      extractFunctionsCodebases({ functions: [{ codebase: 'Bad Name!', source: 'a' }] }),
    ).toThrow(/lowercase letters, numbers, underscores, and hyphens/);
    expect(() =>
      extractFunctionsCodebases({ functions: [{ codebase: 'a'.repeat(64), source: 'a' }] }),
    ).toThrow(/1-63 character/);
    expect(() =>
      extractFunctionsCodebases({ functions: [{ codebase: '', source: 'a' }] }),
    ).toThrow(/1-63 character/);
    expect(() =>
      extractFunctionsCodebases({
        functions: [
          { codebase: 'a', source: 'fn-a' },
          { codebase: 'b' },
        ],
      }),
    ).toThrow(/must specify a non-empty `source`/);
    expect(() =>
      extractFunctionsCodebases({
        functions: [
          { codebase: 'a', source: '   ' },
          { codebase: 'b', source: 'fn-b' },
        ],
      }),
    ).toThrow(/must be a non-empty string/);
    expect(() =>
      extractFunctionsCodebases({
        functions: [
          { codebase: 'dup', source: 'fn-a' },
          { codebase: 'dup', source: 'fn-b' },
        ],
      }),
    ).toThrow(/duplicate Functions codebase "dup"/);
    expect(() =>
      extractFunctionsCodebases({
        functions: [{ source: 'fn-a' }, { source: 'fn-b' }],
      }),
    ).toThrow(/duplicate Functions codebase "default"/);
    expect(() =>
      extractFunctionsCodebases({
        functions: [
          { codebase: 'a', source: 'fn-shared' },
          { codebase: 'b', source: './fn-shared/' },
        ],
      }),
    ).toThrow(/duplicate Functions source/);
  });
});

describe('discoverFunctionsProjects & discoverFunctionsProject (multi-codebase)', () => {
  test('discovers all runnable codebases, warns on partial builds, and guards resolved source collisions', () => {
    const cwd = tempDirs.makeTempDir();
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        functions: [
          { codebase: 'api', source: 'functions-api' },
          { codebase: 'worker', source: 'functions-worker' },
        ],
      }),
    );
    const api = createCodebaseFixture(cwd, 'functions-api', { main: 'dist/index.js', built: true });
    createCodebaseFixture(cwd, 'functions-worker', { main: 'dist/index.js', built: false });

    const warnings: string[] = [];
    const partial = discoverFunctionsProjects(cwd, { warn: (m) => warnings.push(m) });
    expect(partial).toEqual([{ codebase: 'api', sourceDir: api.sourceDir, entry: api.entry }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('codebase "worker"');

    // Once worker is built, both codebases are discovered in order.
    const worker = createCodebaseFixture(cwd, 'functions-worker', {
      main: 'dist/index.js',
      built: true,
    });
    const both = discoverFunctionsProject(cwd, { warn: (m) => warnings.push(m) });
    expect(both).toEqual({
      sourceDir: api.sourceDir,
      entry: api.entry,
      codebase: 'api',
      codebases: [
        { codebase: 'api', sourceDir: api.sourceDir, entry: api.entry },
        { codebase: 'worker', sourceDir: worker.sourceDir, entry: worker.entry },
      ],
    });
    expect(codebasesOfFunctionsProject(both!)).toHaveLength(2);

    // Normalized path alias collision (`sub/../functions-api` vs `functions-api`) is refused.
    const aliasCwd = tempDirs.makeTempDir();
    writeFileSync(
      join(aliasCwd, 'firebase.json'),
      JSON.stringify({
        functions: [
          { codebase: 'a', source: 'functions-api' },
          { codebase: 'b', source: 'sub/../functions-api' },
        ],
      }),
    );
    expect(() => discoverFunctionsProjects(aliasCwd)).toThrow(/duplicate Functions source/);

    // Resolved parent-relative alias (`../<basename>/functions-api`) is also refused.
    const parentAliasCwd = tempDirs.makeTempDir();
    writeFileSync(
      join(parentAliasCwd, 'firebase.json'),
      JSON.stringify({
        functions: [
          { codebase: 'a', source: 'functions-api' },
          { codebase: 'b', source: `../${basename(parentAliasCwd)}/functions-api` },
        ],
      }),
    );
    expect(() => discoverFunctionsProjects(parentAliasCwd)).toThrow(/duplicate Functions source directory/);
  });

  test('returns empty/null for functions: [] without crashing', () => {
    const cwd = tempDirs.makeTempDir();
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ functions: [] }));
    expect(discoverFunctionsProjects(cwd)).toEqual([]);
    expect(discoverFunctionsProject(cwd)).toBeNull();
  });
});

describe('multi-codebase development runtime & duplicate export guards', () => {
  const readyPeer: FunctionsPeerReadiness = { wait: () => Promise.resolve(true) };

  test('detects duplicate export names across HTTP, event, and unsupported triggers and tears down all children', async () => {
    const cbA: FunctionsCodebaseProject = {
      codebase: 'alpha',
      sourceDir: '/tmp/alpha',
      entry: '/tmp/alpha/index.js',
    };
    const cbB: FunctionsCodebaseProject = {
      codebase: 'beta',
      sourceDir: '/tmp/beta',
      entry: '/tmp/beta/index.js',
    };

    const duplicates = findDuplicateCodebaseExports([
      {
        codebase: cbA,
        ready: { triggerCount: 1, unsupportedTriggers: [], exportNames: ['sharedTrigger', 'onlyA'] },
      },
      {
        codebase: cbB,
        ready: { triggerCount: 1, unsupportedTriggers: [], exportNames: ['sharedTrigger', 'onlyB'] },
      },
    ]);
    expect(duplicates).toEqual([{ exportName: 'sharedTrigger', codebases: ['alpha', 'beta'] }]);
    expect(formatDuplicateCodebaseExportsError(duplicates).message).toContain('"sharedTrigger"');
    expect(formatDuplicateCodebaseExportsError(duplicates).message).toContain('"alpha"');
    expect(formatDuplicateCodebaseExportsError(duplicates).message).toContain('"beta"');

    const stoppedCodebases: string[] = [];
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: cbA.sourceDir,
      entry: cbA.entry,
      codebases: [cbA, cbB],
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4100',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      readiness: readyPeer,
      spawn: (opts: SpawnFunctionsChildOptions) => {
        const fake = createFakeChildHandle(
          {
            triggerCount: 0,
            unsupportedTriggers: [],
            exportNames: ['collideApi'],
            http: {
              port: opts.codebase === 'alpha' ? 5001 : 5002,
              token: `tok-${opts.codebase}`,
              functions: [
                {
                  exportName: 'collideApi',
                  regions: ['us-central1'],
                  platform: 'gcfv2',
                  privateInvoker: false,
                  timeoutSeconds: null,
                },
              ],
            },
          },
          { onStop: () => stoppedCodebases.push(opts.codebase ?? 'unknown') },
        );
        return fake.handle;
      },
    });

    const result = await runtime.start();
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error.message).toContain('collideApi');
      expect(result.error.message).toContain('"alpha"');
      expect(result.error.message).toContain('"beta"');
    }
    expect(stoppedCodebases.sort()).toEqual(['alpha', 'beta']);
    await runtime.close();
  });

  test('merges triggers, tags codebase metadata in output/events/logs, handles reload and teardown', async () => {
    const cbA: FunctionsCodebaseProject = {
      codebase: 'api',
      sourceDir: '/tmp/api',
      entry: '/tmp/api/index.js',
    };
    const cbB: FunctionsCodebaseProject = {
      codebase: 'jobs',
      sourceDir: '/tmp/jobs',
      entry: '/tmp/jobs/index.js',
    };

    const events: FunctionsDevelopmentEvent[] = [];
    const stopped: string[] = [];
    let spawnSeq = 0;
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: cbA.sourceDir,
      entry: cbA.entry,
      codebases: [cbA, cbB],
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4100',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      readiness: readyPeer,
      onEvent: (event) => events.push(event),
      spawn: (opts: SpawnFunctionsChildOptions) => {
        spawnSeq += 1;
        const seq = spawnSeq;
        if (opts.codebase === 'api') {
          const fake = createFakeChildHandle(
            {
              triggerCount: 0,
              unsupportedTriggers: [],
              exportNames: ['apiFn'],
              triggers: [{ exportName: 'apiFn', kind: 'http', regions: ['us-central1'] }],
              http: {
                port: 6100 + seq,
                token: `tok-api-${seq}`,
                functions: [
                  {
                    exportName: 'apiFn',
                    regions: ['us-central1'],
                    platform: 'gcfv2',
                    privateInvoker: false,
                    timeoutSeconds: null,
                  },
                ],
              },
            },
            {
              stdoutText: 'api boot\n',
              onStop: () => stopped.push(`api-${seq}`),
            },
          );
          return fake.handle;
        }
        const fake = createFakeChildHandle(
          {
            triggerCount: 2,
            unsupportedTriggers: [{ exportName: 'legacyJob', eventType: 'unknown' }],
            exportNames: ['jobTrigger', 'legacyJob'],
            triggers: [{ exportName: 'jobTrigger', kind: 'google.cloud.firestore.document.v1.created' }],
          },
          {
            stdoutText: 'jobs boot\n',
            onStop: () => stopped.push(`jobs-${seq}`),
          },
        );
        return fake.handle;
      },
    });

    const started = await runtime.start();
    expect(started.kind).toBe('ready');
    if (started.kind !== 'ready') throw new Error('expected ready');

    expect(started.ready.triggerCount).toBe(2);
    expect(started.ready.http?.functions[0]?.codebase).toBe('api');
    expect(started.ready.http?.backends).toHaveLength(1);
    expect(started.ready.triggers).toEqual([
      { exportName: 'apiFn', kind: 'http', codebase: 'api', regions: ['us-central1'] },
      {
        exportName: 'jobTrigger',
        kind: 'google.cloud.firestore.document.v1.created',
        codebase: 'jobs',
      },
    ]);
    expect(started.ready.unsupportedTriggers).toEqual([
      { exportName: 'legacyJob', eventType: 'unknown', codebase: 'jobs' },
    ]);
    expect(started.ready.codebases?.map((c) => c.codebase)).toEqual(['api', 'jobs']);

    // Let PassThrough stdout streams flush into attachOutput's line prefixer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outputLines = events
      .filter((e): e is Extract<FunctionsDevelopmentEvent, { type: 'output' }> => e.type === 'output')
      .map((e) => e.line.trim());
    expect(outputLines).toContain('[functions:api] api boot');
    expect(outputLines).toContain('[functions:jobs] jobs boot');

    expect(functionsTriggersLine(2, 'functions-jobs/index.js', 'jobs')).toBe(
      'functions [jobs] 2 triggers from functions-jobs/index.js',
    );
    expect(httpFunctionLines(started.ready.http!, 'http://127.0.0.1:4100', 'demo-project')).toEqual([
      'functions 1 onRequest function:',
      '    http://127.0.0.1:4100/demo-project/us-central1/apiFn [api]',
    ]);
    expect(
      servedLine({
        exportName: 'apiFn',
        codebase: 'api',
        method: 'GET',
        path: '/api/ping',
        status: 200,
        timedOut: false,
        durationMs: 12,
      }).line,
    ).toContain('[api] apiFn');

    const sandbox = initializeSandbox();
    try {
      recordFunctionExecution(sandbox, {
        trigger: 'jobTrigger',
        codebase: 'jobs',
        ref: 'orders/1',
        params: { id: '1' },
        startedAt: 100,
        durationMs: 5,
        status: 'fulfilled',
        result: { ok: true },
      });
      const records = listExecutions(sandbox);
      expect(records).toHaveLength(1);
      expect(records[0]?.codebase).toBe('jobs');
    } finally {
      sandbox.dispose();
    }

    const reloaded = await runtime.reload();
    expect(reloaded.kind).toBe('ready');
    expect(stopped).toHaveLength(2);

    await runtime.close();
    expect(stopped).toHaveLength(4);
  });
});
