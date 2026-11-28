import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMMANDS_BEFORE_SERVICES, dispatch, parseArgs } from '../../src/cli/index.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_USAGE,
  runPolicy,
  type PolicyCliDeps,
} from '../../src/cli/policy/index.js';

const pkgRoot = resolve(import.meta.dir, '../..');
const srcEntry = join(pkgRoot, 'src/cli/index.ts');
const distEntry = join(pkgRoot, 'dist/cli/index.js');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-dispatch-'));
  tempDirs.push(dir);
  return dir;
}

function bufferIo() {
  let out = '';
  let err = '';
  return {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
    getOut: () => out,
    getErr: () => err,
  };
}

async function run(argv: string[], extra: Partial<PolicyCliDeps> = {}) {
  const io = bufferIo();
  const code = await runPolicy(parseArgs(['policy', ...argv]), { ...io, ...extra });
  return { code, out: io.getOut(), err: io.getErr() };
}

describe('pyric policy dispatch and CLI hygiene', () => {
  it('registers policy before the lazy service-command registry', () => {
    expect(COMMANDS_BEFORE_SERVICES.has('policy')).toBe(true);
  });

  it('never uses data: URIs for ESM loading inside policy source files', () => {
    const dir = join(pkgRoot, 'src/cli/policy');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toContain('data:text/javascript');
    }
  });

  it('renders ASCII help for root and each subcommand with exit 0', async () => {
    for (const argv of [
      [],
      ['--help'],
      ['-h'],
      ['check', '--help'],
      ['prove', '--help'],
      ['emit', '--help'],
    ]) {
      const res = await run(argv);
      expect(res.code).toBe(POLICY_EXIT_OK);
      expect(res.err).toBe('');
      expect(res.out).toContain('pyric policy');
      expect(/^[\x00-\x7f]*$/.test(res.out)).toBe(true);
    }
  });

  it('routes policy --help through top-level dispatch without failing unknown command', async () => {
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await dispatch(parseArgs(['policy', 'prove', '--help']));
      expect(code).toBe(0);
      expect(captured).toContain('pyric policy prove');
      expect(captured).toContain('--fuzz-cases');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('returns structured exit 1 JSON errors for missing or unknown subcommands', async () => {
    const bareJson = await run(['--json']);
    expect(bareJson.code).toBe(POLICY_EXIT_USAGE);
    expect(bareJson.err).toBe('');
    const p1 = JSON.parse(bareJson.out);
    expect(p1.schema).toBe('pyric.policy.v1');
    expect(p1.ok).toBe(false);
    expect(p1.exitCode).toBe(1);
    expect(p1.diagnostics[0].code).toBe('USAGE_ERROR');

    const badSub = await run(['bogus', '--json']);
    expect(badSub.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(badSub.out).diagnostics[0].message).toContain("unknown policy subcommand 'bogus'");

    const badSubHelp = await run(['bogus', '--help']);
    expect(badSubHelp.code).toBe(POLICY_EXIT_USAGE);
    expect(badSubHelp.err).toContain('bogus');
  });

  it('rejects unknown flags, missing flag values, missing file, and extra positionals', async () => {
    const unk = await run(['check', 'a.policy', '--bogus', '--json']);
    expect(unk.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(unk.out).diagnostics[0].message).toContain('--bogus');

    const missVal = await run(['check', 'a.policy', '--mode', '--json']);
    expect(missVal.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(missVal.out).diagnostics[0].message).toContain('--mode');

    const noFile = await run(['check', '--json']);
    expect(noFile.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(noFile.out).diagnostics[0].message).toContain('missing policy file');

    const extra = await run(['check', 'a.policy', 'b.policy', '--json']);
    expect(extra.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(extra.out).diagnostics[0].message).toContain('b.policy');
  });

  it('returns IO_ERROR exit 1 for unreadable files and validates malformed JSON inputs', async () => {
    const dir = makeTempDir();
    const missing = await run(['check', join(dir, 'nope.policy'), '--json']);
    expect(missing.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(missing.out).diagnostics[0].code).toBe('IO_ERROR');

    const pol = join(dir, 'ok.policy');
    writeFileSync(pol, 'transition t { require r { return after.x == before.x; } }\n');
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{not json');
    const rBad = await run(['check', pol, '--firestore-bindings', badJson, '--json']);
    expect(rBad.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rBad.out).diagnostics[0].message).toContain('invalid JSON');

    const protoJson = join(dir, 'proto.json');
    writeFileSync(protoJson, '{"__proto__": "resource.data.x"}');
    const rProto = await run(['check', pol, '--firestore-bindings', protoJson, '--json']);
    expect(rProto.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rProto.out).diagnostics[0].message).toContain('forbidden key');

    const badCfg = join(dir, 'bad-cfg.json');
    writeFileSync(badCfg, '{"firestore": "not-an-object"}');
    const rCfg = await run(['check', pol, '--config', badCfg, '--json']);
    expect(rCfg.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rCfg.out).diagnostics[0].message).toContain('config.firestore');

    const badFuzzSeed = join(dir, 'bad-seed-cfg.json');
    writeFileSync(badFuzzSeed, '{"fuzz": {"seed": -5}}');
    const rSeed = await run(['prove', pol, '--config', badFuzzSeed, '--json']);
    expect(rSeed.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rSeed.out).diagnostics[0].message).toContain('config.fuzz.seed');

    const nullMode = join(dir, 'null-mode.json');
    writeFileSync(nullMode, '{"mode": null}');
    const rNullMode = await run(['check', pol, '--config', nullMode, '--json']);
    expect(rNullMode.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rNullMode.out).diagnostics[0].message).toContain('config.mode');

    const typoCfg = join(dir, 'typo-cfg.json');
    writeFileSync(typoCfg, '{"typoFlag": true}');
    const rTypo = await run(['check', pol, '--config', typoCfg, '--json']);
    expect(rTypo.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rTypo.out).diagnostics[0].message).toContain("unknown key 'typoFlag'");

    const typoFuzz = join(dir, 'typo-fuzz.json');
    writeFileSync(typoFuzz, '{"fuzz": {"badKey": 1}}');
    const rTypoFuzz = await run(['prove', pol, '--config', typoFuzz, '--json']);
    expect(rTypoFuzz.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(rTypoFuzz.out).diagnostics[0].message).toContain("unknown key 'badKey'");
  });

  it('validates flag ranges, path traversal in --name, and unsafe --rtdb-path segments', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'ok.policy');
    writeFileSync(pol, 'transition t { require r { return after.x == before.x; } }\n');

    const badKind = await run(['check', pol, '--kind', 'bogus', '--json']);
    expect(badKind.code).toBe(POLICY_EXIT_USAGE);

    const badMode = await run(['check', pol, '--mode', 'strict', '--json']);
    expect(badMode.code).toBe(POLICY_EXIT_USAGE);

    const badSeed = await run(['prove', pol, '--seed=abc', '--json']);
    expect(badSeed.code).toBe(POLICY_EXIT_USAGE);

    const badCases = await run(['prove', pol, '--fuzz-cases', '9999', '--json']);
    expect(badCases.code).toBe(POLICY_EXIT_USAGE);

    const badLimit = await run(['check', pol, '--expression-limit', '0', '--json']);
    expect(badLimit.code).toBe(POLICY_EXIT_USAGE);

    const badName = await run(['emit', pol, '--no-write', '--name', '../escape', '--json']);
    expect(badName.code).toBe(POLICY_EXIT_USAGE);

    const badPath1 = await run(['emit', pol, '--no-write', '--rtdb-path', 'relative/path', '--json']);
    expect(badPath1.code).toBe(POLICY_EXIT_USAGE);

    const badPath2 = await run(['emit', pol, '--no-write', '--rtdb-path', '/rooms/__proto__', '--json']);
    expect(badPath2.code).toBe(POLICY_EXIT_USAGE);

    for (const segPath of ['/rooms/a$b', '/rooms/a\x01b', '/rooms/a\x7fb', '/rooms/$', '/rooms/$1bad', '/rooms/$a$b']) {
      const r = await run(['emit', pol, '--no-write', '--rtdb-path', segPath, '--json']);
      expect(r.code).toBe(POLICY_EXIT_USAGE);
    }
    const okWildcard = await run(['emit', pol, '--no-write', '--rtdb-path', '/rooms/$room_id', '--json']);
    expect(okWildcard.code).toBe(POLICY_EXIT_OK);

    // Trailing `--` passthrough args must fail with USAGE_ERROR.
    const trailing = await run(['check', pol, '--json', '--', 'extra-garbage', '--bogus']);
    expect(trailing.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(trailing.out).diagnostics[0].message).toContain("after '--'");

    const bareTrailing = await run(['--', 'extra']);
    expect(bareTrailing.code).toBe(POLICY_EXIT_USAGE);
    expect(bareTrailing.err).toContain("after '--'");

    // Strict boolean flags reject arbitrary strings.
    const badJsonFlag = await run(['check', pol, '--json=banana']);
    expect(badJsonFlag.code).toBe(POLICY_EXIT_USAGE);
    expect(badJsonFlag.out).toBe('');
    expect(badJsonFlag.err).toContain('invalid --json');

    const badNoFuzz = await run(['prove', pol, '--no-fuzz=banana', '--json']);
    expect(badNoFuzz.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(badNoFuzz.out).diagnostics[0].message).toContain('invalid --no-fuzz');

    const badHelp = await run(['check', pol, '--help=banana', '--json']);
    expect(badHelp.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(badHelp.out).diagnostics[0].message).toContain('invalid --help');

    // Repeated scalar flags validate every occurrence, taking the last valid value.
    const badDupSeed = await run(['prove', pol, '--seed', 'notanumber', '--seed', '42', '--no-fuzz', '--json']);
    expect(badDupSeed.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(badDupSeed.out).diagnostics[0].message).toContain('--seed');

    const okDupSeed = await run(['prove', pol, '--seed', '1', '--seed', '42', '--no-fuzz', '--json']);
    expect(okDupSeed.code).toBe(POLICY_EXIT_OK);
    expect(JSON.parse(okDupSeed.out).fuzz.seed).toBe(42);
  });

  it('reads policy source from stdin when given - and catches loader errors cleanly', async () => {
    const ok = await run(['check', '-', '--json'], {
      readStdin: async () => 'transition inc { require pos { return after.n > before.n; } }\n',
    });
    expect(ok.code).toBe(0);
    const parsed = JSON.parse(ok.out);
    expect(parsed.file).toBe('-');
    expect(parsed.staticCheck.transitionName).toBe('inc');

    const fail = await run(['check', '-', '--json'], {
      readStdin: async () => 'transition inc { require pos { return true; } }\n',
      loadPolicyApi: async () => {
        throw new Error('simulated missing dist');
      },
    });
    expect(fail.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(fail.out).diagnostics[0].code).toBe('LOADER_ERROR');
  });

  it('runs end-to-end as a subprocess under bun and node (when dist is built)', () => {
    const dir = makeTempDir();
    const pol = join(dir, 'step.policy');
    writeFileSync(
      pol,
      'transition step { require inc { return before.n is int && after.n is int && after.n == before.n + 1; } }\n',
    );

    const bunRun = spawnSync('bun', [srcEntry, 'policy', 'check', pol, '--json'], {
      cwd: pkgRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(bunRun.status).toBe(0);
    expect(bunRun.stderr).toBe('');
    expect(JSON.parse(bunRun.stdout).ok).toBe(true);

    if (existsSync(distEntry)) {
      const nodeRun = spawnSync('node', [distEntry, 'policy', 'prove', pol, '--fuzz-cases', '8', '--json'], {
        cwd: pkgRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(nodeRun.status).toBe(0);
      expect(nodeRun.stderr).toBe('');
      const report = JSON.parse(nodeRun.stdout);
      expect(report.ok).toBe(true);
      expect(report.standalone.esmVerified).toBe(true);
      expect(report.fuzz.casesRun).toBe(8);
    }
  });
});
