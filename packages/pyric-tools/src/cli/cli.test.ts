/**
 * CLI argument-parsing + dispatch tests.
 *
 * Each subcommand handler accepts an injectable `deps` arg so the
 * tests assert dispatch happens with the right shape without going
 * near the real Google APIs, real disk reads, or real service-account
 * loading. The injection seam is the contract — these tests pin it.
 *
 * Conventions:
 *   - `bufferIo()` returns `{ stdout, stderr, getOut, getErr }`
 *     suitable for handing to any subcommand's `deps`.
 *   - Helper `makeScope()` returns a structurally-valid ProjectScope
 *     without hitting the JWT flow.
 *   - Argv is parsed via the real `parseArgs` to exercise the CLI's
 *     flag handling end-to-end (no shortcuts).
 */

import { describe, it, expect, mock } from 'bun:test';

import { parseArgs } from './parse-args.js';
import { runDeploy, runHostingChannelDeploy } from './deploy.js';
import { runRulesLint, runRulesValidate, runRulesSimulate } from './rules.js';
import {
  runDatabaseRulesLint,
  runDatabaseRulesValidate,
  runDatabaseRulesSimulate,
  runDatabaseRulesGenerate,
} from './database-rules.js';
import { runAuthConfigureProvider, runAuthManageDomains } from './auth.js';
import { runFirestoreDiscover } from './discover.js';
import { runInit } from './init.js';
import type { ProjectScope } from '../deploy/index.js';

// ── Test helpers ──────────────────────────────────────────────────────

function bufferIo() {
  let outBuf = '';
  let errBuf = '';
  return {
    stdout: { write(s: string): void { outBuf += s; } },
    stderr: { write(s: string): void { errBuf += s; } },
    getOut: () => outBuf,
    getErr: () => errBuf,
    // Deploy's API-enablement preflight is injectable; the dispatch tests skip
    // the real Service Usage calls (covered in deploy/api-enablement.test.ts).
    ensureApis: async () => ({ ok: true }),
  };
}

function makeScope(projectId = 'test-project'): ProjectScope {
  return {
    projectId,
    resolveToken: async () => 'test-token',
  };
}

// Build a `ToolHandler`-shaped object that records its inputs and
// returns a configurable result. Avoids importing `ToolHandler` from
// @inbrowser/agent for the test surface — we only care about `name`
// + `execute` for dispatch verification.
function makeFakeTool(
  name: string,
  result: { ok: boolean; summary: string; data?: unknown },
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
) {
  const calls: Array<{ args: unknown }> = [];
  return {
    handler: {
      name,
      description: '',
      parameters,
      async execute(args: unknown) {
        calls.push({ args });
        return result;
      },
    },
    calls,
  };
}

// ── parseArgs ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('captures subcommand + positionals + long flags', () => {
    const p = parseArgs(['deploy', 'rules', '--project', 'my-proj']);
    expect(p.subcommand).toBe('deploy');
    expect(p.positional).toEqual(['rules']);
    expect(p.flags.get('project')).toBe('my-proj');
  });

  it('parses --flag=value syntax', () => {
    const p = parseArgs(['rules:simulate', '--stdin=true']);
    expect(p.flags.get('stdin')).toBe('true');
  });

  it('treats a flag without a value as boolean true', () => {
    const p = parseArgs(['rules:simulate', '--stdin']);
    expect(p.flags.get('stdin')).toBe(true);
  });

  it('preserves repeated long flags in order', () => {
    const p = parseArgs([
      'verify',
      '--service',
      'firestore',
      '--service',
      'rtdb',
      '--rules=firestore=firestore.rules',
      '--rules',
      'rtdb=database.rules.json',
    ]);
    expect(p.flags.get('service')).toEqual(['firestore', 'rtdb']);
    expect(p.flags.get('rules')).toEqual([
      'firestore=firestore.rules',
      'rtdb=database.rules.json',
    ]);
  });
});

// ── deploy ────────────────────────────────────────────────────────────

describe('runDeploy', () => {
  it('returns usage error when no target given', async () => {
    const io = bufferIo();
    const code = await runDeploy(parseArgs(['deploy']), { ...io, cwd: '/tmp/nope' });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing target');
  });

  it('rejects unknown targets', async () => {
    const io = bufferIo();
    const code = await runDeploy(parseArgs(['deploy', 'launch-rockets']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('unknown target');
  });

  it('dispatches `deploy rules` through the firestore tool factory', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('firestore_deploy_rules', { ok: true, summary: 'Deployed rules' });
    const createFn = mock(() => [tool.handler]);
    const readFileFn = mock(async () => 'rules_version = "2";');
    const code = await runDeploy(parseArgs(['deploy', 'rules']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({ firestore: { rules: 'firestore.rules' } }),
      readFirebaseRc: async () => ({ projects: { default: 'p' } }),
      resolveScope: async () => ({ scope: makeScope('p'), source: 'GOOGLE_APPLICATION_CREDENTIALS' }),
      readFile: readFileFn as never,
      createFirestoreDeployTools: createFn,
    });
    expect(code).toBe(0);
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(tool.calls.length).toBe(1);
    expect((tool.calls[0]?.args as { source: string }).source).toBe('rules_version = "2";');
    expect(io.getOut()).toContain('Deployed rules');
  });

  it('dispatches `deploy indexes` with parsed config', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('firestore_deploy_indexes', {
      ok: true,
      summary: 'Indexes: 0 started, 0 already exist',
    });
    const createFn = mock(() => [tool.handler]);
    const code = await runDeploy(parseArgs(['deploy', 'indexes']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({ firestore: { indexes: 'firestore.indexes.json' } }),
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      readFile: (async () => '{"indexes":[]}') as never,
      createFirestoreDeployTools: createFn,
    });
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as { config: { indexes: unknown[] } };
    expect(args.config.indexes).toEqual([]);
  });

  it('requires --source and --config for `deploy functions`', async () => {
    const io = bufferIo();
    const code = await runDeploy(parseArgs(['deploy', 'functions']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({}),
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
    });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('--source');
  });

  it('dispatches `deploy hosting` through the hosting tool factory', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'Hosting deploy ok' });
    const createFn = mock(() => [tool.handler]);
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({
        hosting: [{ site: 'demo-site', public: 'public' }],
      }),
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      createHostingDeployTools: createFn,
    });
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as { siteId: string; localDir: string };
    expect(args.siteId).toBe('demo-site');
    expect(args.localDir).toContain('public');
  });

  const hostingDeps = (tool: ReturnType<typeof makeFakeTool>) => ({
    cwd: '/tmp',
    readFirebaseJson: async () => ({ hosting: [{ site: 'demo-site', public: 'public' }] }),
    readFirebaseRc: async () => null,
    resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
    createHostingDeployTools: mock(() => [tool.handler]),
  });

  it('threads --channel and --channel-ttl through to the hosting tool', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', {
      ok: true,
      summary: 'Hosting deploy ok — 1/1 files uploaded; preview at https://demo-site--pr-1-abc123de.web.app (expires 2026-06-17T00:00:00Z)',
    });
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--channel', 'pr-1', '--channel-ttl', '12h']),
      { ...io, ...hostingDeps(tool) },
    );
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as { channelId?: string; channelTtl?: string };
    expect(args.channelId).toBe('pr-1');
    expect(args.channelTtl).toBe('43200s'); // 12h → protobuf Duration
    // The summary (preview URL + expireTime) reaches stdout.
    expect(io.getOut()).toContain('https://demo-site--pr-1-abc123de.web.app');
    expect(io.getOut()).toContain('expires 2026-06-17T00:00:00Z');
  });

  it('--channel auto derives a sanitized channel id from the git branch', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--channel', 'auto']), {
      ...io,
      ...hostingDeps(tool),
      getGitBranch: async () => 'Feat/Auth_Resolver.P4',
    });
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as { channelId?: string };
    expect(args.channelId).toBe('feat-auth-resolver-p4');
  });

  it('--channel auto on a detached HEAD demands an explicit id', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--channel', 'auto']), {
      ...io,
      ...hostingDeps(tool),
      getGitBranch: async () => 'HEAD',
    });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('detached HEAD');
    expect(tool.calls.length).toBe(0);
  });

  it('rejects a malformed --channel-ttl before deploying', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--channel', 'pr-1', '--channel-ttl', '7w']),
      { ...io, ...hostingDeps(tool) },
    );
    expect(code).toBe(1);
    expect(io.getErr()).toContain('--channel-ttl');
    expect(tool.calls.length).toBe(0);
  });

  it('rejects --channel-ttl without --channel', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--channel-ttl', '7d']),
      { ...io, ...hostingDeps(tool) },
    );
    expect(code).toBe(1);
    expect(io.getErr()).toContain('requires --channel');
    expect(tool.calls.length).toBe(0);
  });

  it('omits channel fields entirely for a plain hosting deploy', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), { ...io, ...hostingDeps(tool) });
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as Record<string, unknown>;
    expect('channelId' in args).toBe(false);
    expect('channelTtl' in args).toBe(false);
  });

  // ── A3: full hosting block threading ────────────────────────────────

  it('threads the full hosting block (config + ignore) into the tool; deploy keys are stripped', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => ({
        hosting: {
          site: 'demo-site',
          public: 'dist',
          ignore: ['firebase.json', '**/.*'],
          rewrites: [{ source: '**', destination: '/index.html' }],
          redirects: [{ source: '/old', destination: '/new', type: 302 }],
          headers: [{ source: '**/*.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }],
          cleanUrls: true,
          trailingSlash: false,
        },
      }),
    });
    expect(code).toBe(0);
    const args = tool.calls[0]?.args as Record<string, unknown>;
    expect(args.siteId).toBe('demo-site');
    expect(args.ignore).toEqual(['firebase.json', '**/.*']);
    expect(args.config).toEqual({
      rewrites: [{ source: '**', destination: '/index.html' }],
      redirects: [{ source: '/old', destination: '/new', type: 302 }],
      headers: [{ source: '**/*.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }],
      cleanUrls: true,
      trailingSlash: false,
    });
    // Deploy-mechanics keys are consumed by the CLI, not forwarded.
    const config = args.config as Record<string, unknown>;
    expect('public' in config).toBe(false);
    expect('site' in config).toBe(false);
    expect('ignore' in config).toBe(false);
  });

  it('warns loudly on unsupported hosting keys but still deploys', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => ({
        hosting: { site: 'demo-site', public: 'dist', predeploy: ['npm run build'], sparkles: true },
      }),
    });
    expect(code).toBe(0);
    expect(tool.calls.length).toBe(1);
    expect(io.getErr()).toContain("'predeploy'");
    expect(io.getErr()).toContain("'sparkles'");
  });

  it('rejects invalid hosting config (dynamicLinks) before any deploy', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => ({
        hosting: {
          site: 'demo-site',
          public: 'dist',
          rewrites: [{ source: '/l/**', dynamicLinks: true }],
        },
      }),
    });
    expect(code).toBe(1);
    expect(tool.calls.length).toBe(0);
    expect(io.getErr()).toContain('dynamicLinks');
  });

  const multiSiteJson = {
    hosting: [
      { site: 'site-one', public: 'one' },
      { site: 'site-two', target: 'web', public: 'two' },
    ],
  };

  it('defaults to the FIRST hosting entry when --only is absent', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => multiSiteJson,
    });
    expect(code).toBe(0);
    expect(tool.calls.length).toBe(1);
    expect((tool.calls[0]?.args as { siteId: string }).siteId).toBe('site-one');
  });

  it('--only hosting:<site> and --only hosting:<target> select the matching entry', async () => {
    for (const key of ['site-two', 'web']) {
      const io = bufferIo();
      const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
      const code = await runDeploy(parseArgs(['deploy', 'hosting', '--only', `hosting:${key}`]), {
        ...io,
        ...hostingDeps(tool),
        readFirebaseJson: async () => multiSiteJson,
      });
      expect(code).toBe(0);
      expect(tool.calls.length).toBe(1);
      expect((tool.calls[0]?.args as { siteId: string }).siteId).toBe('site-two');
      expect((tool.calls[0]?.args as { localDir: string }).localDir).toContain('two');
    }
  });

  it('--only hosting:<unknown> errors and lists the declared entries', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--only', 'hosting:nope']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => multiSiteJson,
    });
    expect(code).toBe(1);
    expect(tool.calls.length).toBe(0);
    expect(io.getErr()).toContain('site-one');
  });

  // ── A4: .firebaserc aliases + hosting targets ───────────────────────

  it('--project <alias> resolves through the .firebaserc projects map (rc.ts:79-81 mirror)', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const seen: Array<string | undefined> = [];
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--project', 'staging']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseRc: async () => ({
        projects: { default: 'prod-project', staging: 'staging-project' },
      }),
      resolveScope: async ({ projectId }: { projectId?: string }) => {
        seen.push(projectId);
        return { scope: makeScope(projectId ?? 'none'), source: 'FIREBASE_SA_BASE64' };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(['staging-project']);
  });

  it('--project with a non-alias value passes through as a literal project id', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const seen: Array<string | undefined> = [];
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--project', 'literal-id']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseRc: async () => ({ projects: { default: 'prod-project' } }),
      resolveScope: async ({ projectId }: { projectId?: string }) => {
        seen.push(projectId);
        return { scope: makeScope(projectId ?? 'none'), source: 'FIREBASE_SA_BASE64' };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(['literal-id']);
  });

  it('a target-only hosting entry resolves to its site(s) via .firebaserc targets', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => ({ hosting: [{ target: 'web', public: 'dist' }] }),
      readFirebaseRc: async () => ({
        projects: { default: 'test-project' },
        targets: { 'test-project': { hosting: { web: ['site-a', 'site-b'] } } },
      }),
    });
    expect(code).toBe(0);
    expect(tool.calls.map((c) => (c.args as { siteId: string }).siteId)).toEqual([
      'site-a',
      'site-b',
    ]);
  });

  // ── A5: hosting:channel:deploy mirror alias ─────────────────────────

  it('hosting:channel:deploy <id> --expires produces the IDENTICAL tool invocation as deploy hosting --channel --channel-ttl', async () => {
    // The equivalence pin: both spellings route through runDeploy and
    // must hand the handler byte-identical args — they can't drift.
    const toolA = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const ioA = bufferIo();
    const codeA = await runDeploy(
      parseArgs(['deploy', 'hosting', '--channel', 'pr-7', '--channel-ttl', '12h']),
      { ...ioA, ...hostingDeps(toolA) },
    );
    const toolB = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const ioB = bufferIo();
    const codeB = await runHostingChannelDeploy(
      parseArgs(['hosting:channel:deploy', 'pr-7', '--expires', '12h']),
      { ...ioB, ...hostingDeps(toolB) },
    );
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(toolB.calls.length).toBe(1);
    expect(toolB.calls[0]?.args).toEqual(toolA.calls[0]?.args);
  });

  it('--expires works as an alias of --channel-ttl on deploy hosting too', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--channel', 'pr-1', '--expires', '30m']),
      { ...io, ...hostingDeps(tool) },
    );
    expect(code).toBe(0);
    expect((tool.calls[0]?.args as { channelTtl?: string }).channelTtl).toBe('1800s');
  });

  it('hosting:channel:deploy without a channelId is a usage error', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runHostingChannelDeploy(parseArgs(['hosting:channel:deploy']), {
      ...io,
      ...hostingDeps(tool),
    });
    expect(code).toBe(1);
    expect(tool.calls.length).toBe(0);
    expect(io.getErr()).toContain('missing <channelId>');
  });

  it('a target with no .firebaserc mapping errors before any deploy', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting']), {
      ...io,
      ...hostingDeps(tool),
      readFirebaseJson: async () => ({ hosting: [{ target: 'web', public: 'dist' }] }),
      readFirebaseRc: async () => ({ projects: { default: 'test-project' } }),
    });
    expect(code).toBe(1);
    expect(tool.calls.length).toBe(0);
    expect(io.getErr()).toContain("target 'web'");
  });

  // ── A6: agent I/O — the ToolHandler IS the schema ───────────────────

  const neverCalled = (what: string) => async () => {
    throw new Error(`${what} must not be called in this mode`);
  };

  it('deploy hosting --schema prints the REAL hosting_deploy parameters without credentials or firebase.json', async () => {
    const io = bufferIo();
    // No createHostingDeployTools override — the real factory runs with
    // a stub scope; firebase.json / credentials must never be touched.
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--schema']), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      resolveScope: neverCalled('resolveScope') as never,
    });
    expect(code).toBe(0);
    const schema = JSON.parse(io.getOut()) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['siteId']);
    for (const key of ['siteId', 'localDir', 'files', 'ignore', 'config', 'channelId', 'channelTtl']) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });

  it('deploy rules --schema prints the provider tool parameters without credentials or firebase.json', async () => {
    const io = bufferIo();
    const code = await runDeploy(parseArgs(['deploy', 'rules', '--schema']), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      resolveScope: neverCalled('resolveScope') as never,
    });
    expect(code).toBe(0);
    const schema = JSON.parse(io.getOut()) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['source']);
    expect(Object.keys(schema.properties)).toContain('source');
  });

  it("deploy hosting --json '<payload>' feeds the handler DIRECTLY and skips firebase.json", async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok', data: { fine: true } });
    const payload = {
      siteId: 'agent-site',
      localDir: '/abs/dist',
      config: { cleanUrls: true },
      channelId: 'pr-9',
    };
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--json', JSON.stringify(payload)]), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      createHostingDeployTools: mock(() => [tool.handler]),
    });
    expect(code).toBe(0);
    // The payload IS the tool input — no reshaping, no flag merging.
    expect(tool.calls[0]?.args).toEqual(payload);
    // stdout is exactly the handler result as JSON; banner went to stderr.
    expect(JSON.parse(io.getOut())).toEqual({ ok: true, summary: 'ok', data: { fine: true } });
    expect(io.getErr()).toContain("using project 'test-project'");
  });

  it('--json payload failing schema validation exits 1 with a JSON error on stderr (no tool call)', async () => {
    const io = bufferIo();
    // Validation reads the HANDLER's parameters (the schema is the
    // tool's, not a hand-authored copy) — give the fake the real
    // tool's required shape.
    const tool = makeFakeTool(
      'hosting_deploy',
      { ok: true, summary: 'ok' },
      { type: 'object', properties: { siteId: { type: 'string' }, localDir: { type: 'string' } }, required: ['siteId'] },
    );
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--json', '{"localDir":"/x"}']),
      {
        ...io,
        cwd: '/tmp/nope',
        readFirebaseJson: neverCalled('readFirebaseJson') as never,
        readFirebaseRc: async () => null,
        resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
        createHostingDeployTools: mock(() => [tool.handler]),
      },
    );
    expect(code).toBe(1);
    expect(tool.calls.length).toBe(0);
    const errJson = JSON.parse(io.getErr().split('\n').find((l) => l.startsWith('{'))!) as {
      ok: boolean;
      details: string[];
    };
    expect(errJson.ok).toBe(false);
    expect(errJson.details).toContain('input.siteId is required');
  });

  it('--json with a non-JSON payload exits 1 with a JSON error on stderr', async () => {
    const io = bufferIo();
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--json', 'not json']), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
    });
    expect(code).toBe(1);
    const errLine = io.getErr().split('\n').find((l) => l.startsWith('{'))!;
    expect((JSON.parse(errLine) as { ok: boolean }).ok).toBe(false);
  });

  it("deploy rules --json '<payload>' feeds the provider handler directly", async () => {
    const io = bufferIo();
    const tool = makeFakeTool(
      'firestore_deploy_rules',
      { ok: true, summary: 'rules ok' },
      { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    );
    const payload = { source: 'rules_version = "2";' };
    const code = await runDeploy(parseArgs(['deploy', 'rules', '--json', JSON.stringify(payload)]), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      createFirestoreDeployTools: mock(() => [tool.handler]),
    });
    expect(code).toBe(0);
    expect(tool.calls[0]?.args).toEqual(payload);
    expect(JSON.parse(io.getOut())).toEqual({ ok: true, summary: 'rules ok' });
  });

  it('--json payload with an unknown key warns (typo guard) but still executes', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok' });
    const code = await runDeploy(
      parseArgs(['deploy', 'hosting', '--json', '{"siteId":"s","localDirr":"/x"}']),
      {
        ...io,
        cwd: '/tmp/nope',
        readFirebaseJson: neverCalled('readFirebaseJson') as never,
        readFirebaseRc: async () => null,
        resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
        createHostingDeployTools: mock(() => [tool.handler]),
      },
    );
    expect(code).toBe(0);
    expect(tool.calls.length).toBe(1);
    expect(io.getErr()).toContain('localDirr');
  });

  it('--json payload handler failure prints the JSON result to stderr and exits 2', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: false, summary: 'Hosting deploy failed: SITE_NOT_FOUND' });
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--json', '{"siteId":"s"}']), {
      ...io,
      cwd: '/tmp/nope',
      readFirebaseJson: neverCalled('readFirebaseJson') as never,
      readFirebaseRc: async () => null,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      createHostingDeployTools: mock(() => [tool.handler]),
    });
    expect(code).toBe(2);
    expect(io.getOut()).toBe('');
    const errLine = io.getErr().split('\n').find((l) => l.startsWith('{'))!;
    expect((JSON.parse(errLine) as { ok: boolean }).ok).toBe(false);
  });

  it('bare --json keeps the resolved-deploy flow but emits machine output (upstream -j mirror)', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('hosting_deploy', { ok: true, summary: 'ok', data: { siteId: 'demo-site' } });
    const code = await runDeploy(parseArgs(['deploy', 'hosting', '--json']), {
      ...io,
      ...hostingDeps(tool),
    });
    expect(code).toBe(0);
    // firebase.json WAS consulted (resolved deploy) and stdout is pure JSON.
    expect((tool.calls[0]?.args as { siteId: string }).siteId).toBe('demo-site');
    expect(JSON.parse(io.getOut())).toEqual({ ok: true, summary: 'ok', data: { siteId: 'demo-site' } });
    expect(io.getErr()).toContain('using project');
  });

  it('bare --json on rules uses the resolved provider deploy flow', async () => {
    const io = bufferIo();
    const tool = makeFakeTool('firestore_deploy_rules', { ok: true, summary: 'rules ok' });
    const code = await runDeploy(parseArgs(['deploy', 'rules', '--json']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({ firestore: { rules: 'firestore.rules' } }),
      readFirebaseRc: async () => null,
      readFile: (async () => 'rules_version = "2";') as never,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      createFirestoreDeployTools: mock(() => [tool.handler]),
    });
    expect(code).toBe(0);
    expect((tool.calls[0]?.args as { source: string }).source).toBe('rules_version = "2";');
    expect(JSON.parse(io.getOut())).toEqual({ ok: true, summary: 'rules ok' });
    expect(io.getErr()).toContain('using project');
  });
});

// ── rules ─────────────────────────────────────────────────────────────

describe('runRulesLint', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runRulesLint(parseArgs(['rules:lint']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing rules-file path');
  });

  it('passes the source to the linter and prints JSON', async () => {
    const io = bufferIo();
    const lintFn = mock(() => ({ warnings: [], metrics: { sourceSize: 5 } as never }));
    const code = await runRulesLint(parseArgs(['rules:lint', 'firestore.rules']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => 'source') as never,
      lintFirestoreRules: lintFn as never,
    });
    expect(code).toBe(0);
    expect(lintFn).toHaveBeenCalledTimes(1);
    expect(lintFn).toHaveBeenCalledWith('source');
    const out = JSON.parse(io.getOut()) as { warnings: unknown[] };
    expect(out.warnings).toEqual([]);
  });
});

describe('runRulesValidate', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runRulesValidate(parseArgs(['rules:validate']), { ...io });
    expect(code).toBe(1);
  });

  it('reports parse failure with exit 2 on invalid rules', async () => {
    const io = bufferIo();
    const code = await runRulesValidate(parseArgs(['rules:validate', 'bad.rules']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => 'not valid rules at all') as never,
    });
    expect(code).toBe(2);
    expect(io.getErr()).toContain('failed to parse');
  });
});

describe('runRulesSimulate', () => {
  it('runs a sample test against firebase.json rules path', async () => {
    const io = bufferIo();
    const simulateFn = mock(() => ({
      success: true,
      data: { results: [], passed: 0, failed: 0 },
    } as never));
    const code = await runRulesSimulate(parseArgs(['rules:simulate']), {
      ...io,
      cwd: '/tmp',
      readFirebaseJson: async () => ({ firestore: { rules: 'firestore.rules' } }),
      readFile: (async () => 'rules source') as never,
      simulate: simulateFn as never,
    });
    expect(code).toBe(0);
    expect(simulateFn).toHaveBeenCalledTimes(1);
    const callArgs = (simulateFn.mock.calls[0] ?? []) as [string, unknown[]];
    expect(callArgs[0]).toBe('rules source');
    expect(callArgs[1]).toHaveLength(1);
  });

  it('reads request from stdin when --stdin is set', async () => {
    const io = bufferIo();
    const simulateFn = mock(() => ({ success: true, data: { results: [], passed: 0, failed: 0 } } as never));
    const code = await runRulesSimulate(parseArgs(['rules:simulate', '--stdin']), {
      ...io,
      cwd: '/tmp',
      readStdin: async () =>
        JSON.stringify({
          source: 'inline rules',
          testCases: [
            { description: 't', expectation: 'ALLOW', method: 'get', path: 'x/1', auth: null },
            { description: 't2', expectation: 'DENY', method: 'get', path: 'x/2', auth: null },
          ],
        }),
      simulate: simulateFn as never,
    });
    expect(code).toBe(0);
    const callArgs = (simulateFn.mock.calls[0] ?? []) as [string, unknown[]];
    expect(callArgs[0]).toBe('inline rules');
    expect(callArgs[1]).toHaveLength(2);
  });
});

// ── database rules ───────────────────────────────────────────────────

describe('runDatabaseRulesLint', () => {
  it('errors out when no path given', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesLint(parseArgs(['database:rules:lint']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing rules-file path');
  });

  it('prints RTDB expression lints as JSON', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesLint(parseArgs(['database:rules:lint', 'database.rules.json']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => '{"rules":{".read":true,".write":false}}') as never,
    });
    expect(code).toBe(0);
    const out = JSON.parse(io.getOut()) as { warnings: Array<{ code: string }> };
    expect(out.warnings.map((finding) => finding.code).sort()).toEqual([
      'HARDCODED_FALSE',
      'HARDCODED_TRUE',
    ]);
  });
});

describe('runDatabaseRulesValidate', () => {
  it('reports RTDB expression parse errors', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesValidate(parseArgs(['database:rules:validate', 'database.rules.json']), {
      ...io,
      cwd: '/tmp',
      readFile: (async () => '{"rules":{".read":"auth.uid =="}}') as never,
    });
    expect(code).toBe(0);
    const out = JSON.parse(io.getOut()) as { errors: Array<{ code: string }> };
    expect(out.errors.some((finding) => finding.code === 'PARSE_ERROR')).toBe(true);
  });
});

describe('runDatabaseRulesSimulate', () => {
  it('simulates inline RTDB rules from stdin', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesSimulate(parseArgs(['database:rules:simulate', '--stdin']), {
      ...io,
      readStdin: async () =>
        JSON.stringify({
          rulesJson: { rules: { '.read': true } },
          operation: 'read',
          path: '/sample',
          auth: null,
          mockData: {},
        }),
    });
    expect(code).toBe(0);
    const result = JSON.parse(io.getOut()) as { success: boolean; data: { allowed: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.allowed).toBe(true);
  });
});

describe('runDatabaseRulesGenerate', () => {
  it('loads the constraints module, compiles via toJSON(), and writes the file', async () => {
    const { defineRtdbRules, allow, deny } = await import('pyric/rules');
    const doc = defineRtdbRules({
      paths: { '/': { read: allow(), write: deny() } },
    });

    const io = bufferIo();
    const writes: Array<{ path: unknown; contents: unknown }> = [];
    const code = await runDatabaseRulesGenerate(parseArgs(['database:rules:generate']), {
      ...io,
      cwd: '/project',
      loadRulesDocument: (async () => ({ ok: true, document: doc })) as never,
      readFirebaseJson: (async () => ({ database: { rules: 'database.rules.json' } })) as never,
      mkdir: (async () => undefined) as never,
      writeFile: (async (path: unknown, contents: unknown) => {
        writes.push({ path, contents });
      }) as never,
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/project/database.rules.json');
    expect(writes[0]?.contents).toBe(`${JSON.stringify(doc.toJSON(), null, 2)}\n`);
    expect(io.getOut()).toContain('/project/database.rules.json');
  });

  it('reports a clear error when no constraints module is found', async () => {
    const io = bufferIo();
    const code = await runDatabaseRulesGenerate(parseArgs(['database:rules:generate']), {
      ...io,
      cwd: '/project',
      loadRulesDocument: (async () => ({
        ok: false,
        message: 'no constraints module found',
      })) as never,
    });

    expect(code).toBe(1);
    expect(io.getErr()).toContain('no constraints module found');
  });

  it('honors --config and --out flags', async () => {
    const { defineRtdbRules, allow, deny } = await import('pyric/rules');
    const doc = defineRtdbRules({ paths: { '/': { read: deny(), write: deny() } } });

    const io = bufferIo();
    let loadedPath: string | undefined;
    const writes: Array<{ path: unknown }> = [];
    const code = await runDatabaseRulesGenerate(
      parseArgs(['database:rules:generate', '--config', 'rtdb.rules.ts', '--out', 'out/rules.json']),
      {
        ...io,
        cwd: '/project',
        loadRulesDocument: (async (configPath: string) => {
          loadedPath = configPath;
          return { ok: true, document: doc };
        }) as never,
        mkdir: (async () => undefined) as never,
        writeFile: (async (path: unknown) => {
          writes.push({ path });
        }) as never,
      },
    );

    expect(code).toBe(0);
    expect(loadedPath).toBe('rtdb.rules.ts');
    expect(writes[0]?.path).toBe('/project/out/rules.json');
  });
});

// ── auth ──────────────────────────────────────────────────────────────

describe('runAuthConfigureProvider', () => {
  it('requires both provider + enabled args', async () => {
    const io = bufferIo();
    const code = await runAuthConfigureProvider(parseArgs(['auth:configure-provider']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('missing args');
  });

  it('rejects unknown providers', async () => {
    const io = bufferIo();
    const code = await runAuthConfigureProvider(
      parseArgs(['auth:configure-provider', 'apple', 'true']),
      { ...io },
    );
    expect(code).toBe(1);
    expect(io.getErr()).toContain('unknown provider');
  });

  it('calls configureProvider with parsed args', async () => {
    const io = bufferIo();
    const configureProvider = mock(async () => ({ success: true, provider: 'google', enabled: true } as never));
    const code = await runAuthConfigureProvider(
      parseArgs(['auth:configure-provider', 'google', 'true']),
      {
        ...io,
        resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
        readFirebaseRc: async () => null,
        getAuthTools: () =>
          ({
            generateIR: async () => ({}) as never,
            configureProvider: configureProvider as never,
            manageDomains: async () => ({ success: true, authorizedDomains: [] } as never),
          }),
      },
    );
    expect(code).toBe(0);
    expect(configureProvider).toHaveBeenCalledTimes(1);
    expect(configureProvider).toHaveBeenCalledWith({ provider: 'google', enabled: true });
  });
});

describe('runAuthManageDomains', () => {
  it('requires an action arg', async () => {
    const io = bufferIo();
    const code = await runAuthManageDomains(parseArgs(['auth:manage-domains']), { ...io });
    expect(code).toBe(1);
  });

  it('requires a domain for add/remove', async () => {
    const io = bufferIo();
    const code = await runAuthManageDomains(parseArgs(['auth:manage-domains', 'add']), { ...io });
    expect(code).toBe(1);
    expect(io.getErr()).toContain('requires a domain');
  });

  it('lists domains without a domain arg', async () => {
    const io = bufferIo();
    const manageDomains = mock(async () => ({
      success: true,
      authorizedDomains: ['localhost', 'example.com'],
    } as never));
    const code = await runAuthManageDomains(parseArgs(['auth:manage-domains', 'list']), {
      ...io,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      readFirebaseRc: async () => null,
      getAuthTools: () =>
        ({
          generateIR: async () => ({}) as never,
          configureProvider: async () => ({ success: true, provider: 'google', enabled: true } as never),
          manageDomains: manageDomains as never,
        }),
    });
    expect(code).toBe(0);
    expect(manageDomains).toHaveBeenCalledWith({ action: 'list' });
  });

  it('passes the domain arg through for add', async () => {
    const io = bufferIo();
    const manageDomains = mock(async () => ({
      success: true,
      authorizedDomains: ['example.com'],
    } as never));
    const code = await runAuthManageDomains(
      parseArgs(['auth:manage-domains', 'add', 'example.com']),
      {
        ...io,
        resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
        readFirebaseRc: async () => null,
        getAuthTools: () =>
          ({
            generateIR: async () => ({}) as never,
            configureProvider: async () => ({ success: true, provider: 'google', enabled: true } as never),
            manageDomains: manageDomains as never,
          }),
      },
    );
    expect(code).toBe(0);
    expect(manageDomains).toHaveBeenCalledWith({ action: 'add', domain: 'example.com' });
  });
});

// ── discover ──────────────────────────────────────────────────────────

describe('runFirestoreDiscover', () => {
  it('crawls with no filter when no positional given', async () => {
    const io = bufferIo();
    const crawlFn = mock(async () => ({
      events: [],
      discovered: new Map(),
      listOps: 1,
      readOps: 0,
      finalizedSchemas: new Map(),
      complete: true,
    } as never));
    const createFirestore = mock(() => ({ listCollections: async () => [] }) as never);
    const code = await runFirestoreDiscover(parseArgs(['firestore:discover']), {
      ...io,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      readFirebaseRc: async () => null,
      createFirestore: createFirestore as never,
      crawl: crawlFn as never,
    });
    expect(code).toBe(0);
    const callArgs = (crawlFn.mock.calls[0] ?? []) as [unknown, { rootFilter?: unknown }];
    expect(callArgs[1]?.rootFilter).toBeUndefined();
  });

  it('passes a rootFilter when a positional collection is given', async () => {
    const io = bufferIo();
    const crawlFn = mock(async () => ({
      events: [],
      discovered: new Map(),
      listOps: 1,
      readOps: 0,
      finalizedSchemas: new Map(),
      complete: true,
    } as never));
    const createFirestore = mock(() => ({ listCollections: async () => [] }) as never);
    const code = await runFirestoreDiscover(parseArgs(['firestore:discover', 'users']), {
      ...io,
      resolveScope: async () => ({ scope: makeScope(), source: 'FIREBASE_SA_BASE64' }),
      readFirebaseRc: async () => null,
      createFirestore: createFirestore as never,
      crawl: crawlFn as never,
    });
    expect(code).toBe(0);
    const callArgs = (crawlFn.mock.calls[0] ?? []) as [unknown, { rootFilter?: (id: string) => boolean }];
    expect(typeof callArgs[1]?.rootFilter).toBe('function');
    expect(callArgs[1]?.rootFilter?.('users')).toBe(true);
    expect(callArgs[1]?.rootFilter?.('orders')).toBe(false);
  });
});

// ── init ──────────────────────────────────────────────────────────────

describe('runInit', () => {
  it('writes the full local-first Pyric scaffold when none exist', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const mkdirFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/scaffold',
      writeFile: writeFn as never,
      mkdir: mkdirFn as never,
      exists: async () => false,
    });
    expect(code).toBe(0);
    // 9 files: package.json, src/app.ts, .env.example, src/seed.ts,
    // firestore.rules, firebase.json, firestore.indexes.json, README.md,
    // .gitignore
    expect(writeFn).toHaveBeenCalledTimes(9);
    const paths = writeFn.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/tmp/scaffold/package.json');
    expect(paths).toContain('/tmp/scaffold/src/app.ts');
    expect(paths).toContain('/tmp/scaffold/src/seed.ts');
    expect(paths).toContain('/tmp/scaffold/firestore.rules');
    expect(paths).toContain('/tmp/scaffold/firebase.json');
    expect(paths).toContain('/tmp/scaffold/firestore.indexes.json');
    expect(paths).toContain('/tmp/scaffold/README.md');
    expect(paths).toContain('/tmp/scaffold/.gitignore');
    // src/ dir is mkdir'd before writing into it
    expect(mkdirFn).toHaveBeenCalledWith('/tmp/scaffold/src', { recursive: true });
    // package.json uses the directory basename as the project name
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold/package.json');
    expect(pkgCall?.[1]).toContain('"name": "scaffold"');
    // App template: PYRIC_TARGET env picks sandbox vs firebase backend
    const appCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold/src/app.ts');
    expect(appCall?.[1]).toContain("from 'pyric/sandbox'");
    expect(appCall?.[1]).toContain('PYRIC_TARGET');
    expect(appCall?.[1]).toContain('initializeApp({ sandbox: initializeSandbox() })');
  });

  it('honors --name override for the package name', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--name=my-app']), {
      ...io,
      cwd: '/tmp/scaffold-named',
      writeFile: writeFn as never,
      mkdir: mock(async () => undefined) as never,
      exists: async () => false,
    });
    expect(code).toBe(0);
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/scaffold-named/package.json');
    expect(pkgCall?.[1]).toContain('"name": "my-app"');
  });

  it('skips files that already exist (non-package.json)', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/scaffold2',
      writeFile: writeFn as never,
      mkdir: mock(async () => undefined) as never,
      exists: async (p) => p.endsWith('firebase.json'),
    });
    expect(code).toBe(0);
    // 1 package.json + 7 non-package.json files written, firebase.json skipped
    expect(writeFn).toHaveBeenCalledTimes(8);
    expect(io.getOut()).toContain('skipped firebase.json');
  });

  it('merges into an existing package.json — adds missing scripts + deps, never overwrites', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    const existingPkg = JSON.stringify(
      {
        name: 'my-existing-app',
        type: 'module',
        scripts: { test: 'jest', start: 'node existing.js' },
        dependencies: { express: '^4.0.0' },
      },
      null,
      2,
    );
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/merge-test',
      writeFile: writeFn as never,
      readFile: mock(async () => existingPkg) as never,
      mkdir: mock(async () => undefined) as never,
      // Only package.json exists; all others don't.
      exists: async (p) => p.endsWith('package.json'),
    });
    expect(code).toBe(0);
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/merge-test/package.json');
    expect(pkgCall).toBeDefined();
    const written = JSON.parse(pkgCall![1] as string);

    // User's existing values preserved.
    expect(written.name).toBe('my-existing-app');
    expect(written.scripts.test).toBe('jest');
    expect(written.scripts.start).toBe('node existing.js'); // NOT overwritten
    expect(written.dependencies.express).toBe('^4.0.0');

    // Missing pyric scripts + deps added.
    expect(written.scripts.bridge).toBe('pyric bridge');
    expect(written.scripts.dev).toBe('bun --watch src/app.ts');
    expect(written.scripts['deploy:rules']).toBe('pyric deploy rules');
    expect(written.dependencies.pyric).toBe('*');
    expect(written.dependencies['pyric-tools']).toBe('*');
    expect(written.devDependencies.typescript).toBe('^5.7.0');

    // User-facing report mentions the conflict on `start`.
    const out = io.getOut();
    expect(out).toContain('merged package.json');
    expect(out).toContain('scripts.start');
    expect(out).toContain('node existing.js');
  });

  it('reports unchanged when existing package.json already has everything', async () => {
    const io = bufferIo();
    const writeFn = mock(async () => undefined);
    // A package.json that already contains every required field.
    const completePkg = JSON.stringify(
      {
        name: 'complete',
        type: 'module',
        private: true,
        scripts: {
          start: 'bun src/app.ts',
          dev: 'bun --watch src/app.ts',
          bridge: 'pyric bridge',
          'deploy:rules': 'pyric deploy rules',
        },
        dependencies: { pyric: '*', 'pyric-tools': '*' },
        devDependencies: { '@types/bun': 'latest', typescript: '^5.7.0' },
      },
      null,
      2,
    );
    const code = await runInit(parseArgs(['init', '--template=node']), {
      ...io,
      cwd: '/tmp/complete',
      writeFile: writeFn as never,
      readFile: mock(async () => completePkg) as never,
      mkdir: mock(async () => undefined) as never,
      exists: async (p) => p.endsWith('package.json'),
    });
    expect(code).toBe(0);
    // package.json should NOT have been rewritten — 6 other files written.
    const pkgCall = writeFn.mock.calls.find((c) => c[0] === '/tmp/complete/package.json');
    expect(pkgCall).toBeUndefined();
    expect(io.getOut()).toContain('skipped package.json'); // unchanged merge
  });
});

describe('scanForInlinedFirebase', () => {
  it('flags a bundled chunk that inlines real-SDK endpoint hosts', async () => {
    const { scanForInlinedFirebase } = await import('./serve.js');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-inline-scan-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets', 'index-abc.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    const hits = scanForInlinedFirebase(dir);
    expect(hits).toEqual(['assets/index-abc.js']);
  });

  it('stays clean for an unbundled app importing firebase by bare specifier', async () => {
    const { scanForInlinedFirebase } = await import('./serve.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-inline-clean-'));
    writeFileSync(
      join(dir, 'main.js'),
      "import { getAuth } from 'firebase/auth'; import { getFirestore } from 'firebase/firestore';",
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });
});
