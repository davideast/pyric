// The run's sandbox, its recording resolver and its catch-all listener. The
// sandbox test starts a real one; inside it only loopback exists, every
// address routes to loopback, and the only lookups are of `.invalid` names,
// so nothing here can leave the machine.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectEvent, plainAddress } from './recorder/catch-all-log.mjs';
import { nxdomainFor, parseQuestion, queryEvent } from './recorder/dns-log.mjs';
import { DROP_CAPABILITIES, enterArgs, NamespaceUnavailable, overlayScript, ownDirs, sandboxArgs, startEgressNamespace } from './namespace.ts';

/** A DNS query for `name`, type A, recursion desired. */
function query(name: string, id = 0x1234): Buffer {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

describe('dns-log.mjs', () => {
  test('reads the question of a query', () => {
    expect(parseQuestion(query('oauth2.googleapis.com'))).toEqual({ id: 0x1234, name: 'oauth2.googleapis.com', type: 'A', end: 39 });
  });

  test('ignores a message too short or with a compressed name', () => {
    expect(parseQuestion(Buffer.alloc(8))).toBeNull();
    const pointer = Buffer.concat([query('a.b').subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
    expect(parseQuestion(pointer)).toBeNull();
  });

  test('answers NXDOMAIN with the same id and question and no records', () => {
    const message = query('firestore.googleapis.com', 0xbeef);
    const question = parseQuestion(message);
    if (question === null) throw new Error('no question');
    const answer = nxdomainFor(message, question);
    expect(answer.readUInt16BE(0)).toBe(0xbeef);
    expect(answer[2]! & 0x80).toBe(0x80);
    expect(answer[3]! & 0x0f).toBe(3);
    expect([answer.readUInt16BE(4), answer.readUInt16BE(6), answer.readUInt16BE(8), answer.readUInt16BE(10)]).toEqual([1, 0, 0, 0]);
    expect(answer.subarray(12)).toEqual(message.subarray(12, question.end));
  });

  test('records a query with the host’s classification', () => {
    expect(queryEvent({ name: 'oauth2.googleapis.com', type: 'AAAA' }, new Date(0))).toMatchObject({
      layer: 'namespace',
      kind: 'dns',
      queryType: 'AAAA',
      host: 'oauth2.googleapis.com',
      google: true,
      catalogGap: true,
      action: 'refused',
    });
  });
});

describe('catch-all-log.mjs', () => {
  test('records the address a client dialed, without the dual-stack prefix', () => {
    expect(plainAddress('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(plainAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(connectEvent('::ffff:169.254.169.254', 80, new Date(0))).toMatchObject({
      layer: 'namespace',
      kind: 'connect',
      via: 'catch-all',
      address: '169.254.169.254',
      port: 80,
      metadata: true,
      action: 'refused',
    });
  });
});

describe('sandboxArgs', () => {
  const layout = {
    runRoot: '/home/u/pyric-builders/canary/run',
    readOnly: ['/home/u/.cache/npm', '/home/u/repo', '/home/u/repo'],
    resolvConf: '/home/u/pyric-builders/canary/run/resolv.conf',
    hosts: '/home/u/pyric-builders/canary/run/hosts',
    etc: ['ld.so.cache', 'ssl'],
  };
  const args = sandboxArgs(layout);
  /** Each `--flag a b` triple's destination, by flag. */
  const destinations = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 2]] : []));
  const mounted = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

  test('unshares every namespace, as root of its own, with only the network capabilities it needs', () => {
    expect(args.slice(0, 10)).toEqual(['--unshare-all', '--uid', '0', '--gid', '0', '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_NET_BIND_SERVICE', '--die-with-parent']);
    expect(args).not.toContain('--share-net');
  });

  test('binds only the allowlist read-only, and only the run directory read-write', () => {
    expect(destinations('--ro-bind').sort()).toEqual(['/etc/hosts', '/etc/ld.so.cache', '/etc/resolv.conf', '/etc/ssl', '/home/u/.cache/npm', '/home/u/repo', '/usr', ...destinations('--ro-bind').filter((dest) => ['/bin', '/lib', '/lib64', '/sbin'].includes(dest ?? ''))].sort());
    expect(destinations('--bind')).toEqual([layout.runRoot]);
    expect(args.slice(-3)).toEqual(['--bind', layout.runRoot, layout.runRoot]);
  });

  test('gives the sandbox a fresh /dev, /proc, /tmp and /run, and no /mnt or host root', () => {
    expect(mounted('--tmpfs')).toEqual(['/tmp', '/run']);
    expect(mounted('--dev')).toEqual(['/dev']);
    expect(mounted('--proc')).toEqual(['/proc']);
    expect(args.some((arg) => arg === '/mnt' || arg.startsWith('/mnt/') || arg.startsWith('/run/'))).toBe(false);
    expect(destinations('--ro-bind')).not.toContain('/');
    expect(destinations('--bind')).not.toContain('/');
  });

  test('uses the run’s own resolv.conf and hosts', () => {
    const resolvIndex = args.indexOf('/etc/resolv.conf');
    expect(args[resolvIndex - 1]).toBe(layout.resolvConf);
    expect(args[args.indexOf('/etc/hosts') - 1]).toBe(layout.hosts);
  });
});

describe('overlayScript', () => {
  test('mounts each overlay with its upper layer in the sandbox /tmp', () => {
    expect(overlayScript(['/c/npm'])).toBe('mkdir -p /tmp/.overlay/0/upper /tmp/.overlay/0/work && mount -t overlay overlay -o lowerdir=/c/npm,upperdir=/tmp/.overlay/0/upper,workdir=/tmp/.overlay/0/work /c/npm');
    expect(overlayScript([])).toBe('');
  });
});

describe('ownDirs', () => {
  test('is the run root, the sandbox /tmp, and TMPDIR only inside that /tmp', () => {
    expect(ownDirs('/r', {})).toEqual(['/r', '/tmp']);
    expect(ownDirs('/r', { TMPDIR: '/tmp/x/' })).toEqual(['/r', '/tmp', '/tmp/x']);
    expect(ownDirs('/r', { TMPDIR: '/var/tmp' })).toEqual(['/r', '/tmp']);
    expect(ownDirs('/r', { TMPDIR: '/tmpfoo' })).toEqual(['/r', '/tmp']);
  });
});

describe('enterArgs', () => {
  test('drops every capability before the command, and sets the directory inside the sandbox', () => {
    const { command, args } = enterArgs(42, 'npm', ['install'], '/run-dir');
    expect(command).toBe('nsenter');
    expect(args).toEqual(['-t', '42', '-U', '-m', '-n', '-p', '-i', '-u', '-C', '--preserve-credentials', '--root', ...DROP_CAPABILITIES, '/usr/bin/env', '-C', '/run-dir', 'npm', 'install']);
    expect(DROP_CAPABILITIES).toEqual(['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--securebits=+noroot,+noroot_locked', '--']);
    expect(args.some((arg) => arg.startsWith('--wd'))).toBe(false);
  });
});

/**
 * The sandbox test starts a real sandbox, whose inventory walks every bound
 * directory (about 45,000). With a cold file cache, as after a restart, that
 * takes longer than bun's default 5 s.
 */
const SANDBOX_TEST_TIMEOUT_MS = 120_000;

describe('startEgressNamespace', () => {
  test('refuses, rather than running without the block, when the tools are missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-namespace-'));
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'builders-empty-path-'));
    try {
      await expect(startEgressNamespace({ networkLog: join(root, 'network.jsonl'), runRoot: root })).rejects.toBeInstanceOf(NamespaceUnavailable);
    } finally {
      process.env.PATH = path;
    }
  });

  test('runs a command with only loopback and the allowlisted files, and records its lookups and connections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-namespace-'));
    const networkLog = join(root, 'network.jsonl');
    const namespace = await startEgressNamespace({ networkLog, runRoot: root });
    const run = (command: string, args: string[]) => {
      const entered = namespace.enter(command, args, root);
      return spawnSync(entered.command, entered.args, { encoding: 'utf8', timeout: 120_000 });
    };
    try {
      const links = run('ip', ['-o', 'link', 'show']);
      expect(links.stdout.trim().split('\n').map((line) => line.split(':')[1]?.trim())).toEqual(['lo']);

      expect(run('pwd', []).stdout.trim()).toBe(root);
      expect(run('grep', ['-E', '^Cap(Eff|Bnd|Amb)', '/proc/self/status']).stdout.trim().split('\n').map((line) => line.split(/\s+/)[1])).toEqual(['0000000000000000', '0000000000000000', '0000000000000000']);
      expect(run('ls', ['-A', '/run']).stdout.trim()).toBe('');

      const inventory = run('node', [join(import.meta.dir, 'sandbox-inventory.ts'), ...ownDirs(root)]);
      expect(JSON.parse(inventory.stdout).problems).toEqual([]);

      expect(run('getent', ['hosts', 'canary-probe.invalid']).status).not.toBe(0);

      const connect = run('node', ['-e', "require('node:net').connect(80, '192.0.2.1').on('error', (e) => console.log(e.code)).on('close', () => console.log('closed'))"]);
      expect(connect.stdout.trim().split('\n')[0]).toBe('ECONNRESET');
    } finally {
      await namespace.stop();
    }
    const events = readFileSync(networkLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; host: string; port?: number });
    expect(events.filter((event) => event.kind === 'dns').map((event) => event.host)).toContain('canary-probe.invalid');
    expect(events.filter((event) => event.kind === 'connect')).toEqual([expect.objectContaining({ via: 'catch-all', address: '192.0.2.1', port: 80 })]);
  }, SANDBOX_TEST_TIMEOUT_MS);

  test('shows a run the harness’s own files and packages and none of the repo’s, even to cat through a shell', async () => {
    const repo = resolve(import.meta.dir, '../..');
    const source = join(repo, 'packages', 'pyric', 'src');
    const sourceFile = join(source, readdirSync(source).find((name) => name.endsWith('.ts')) ?? 'index.ts');
    expect(existsSync(sourceFile)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'builders-namespace-'));
    const namespace = await startEgressNamespace({ networkLog: join(root, 'network.jsonl'), runRoot: root });
    const run = (command: string, args: string[], cwd = root) => {
      const entered = namespace.enter(command, args, cwd);
      return spawnSync(entered.command, entered.args, { encoding: 'utf8', timeout: 120_000 });
    };
    const listing = (dir: string) => run('ls', ['-A', dir]).stdout.trim().split('\n').filter((name) => name !== '');
    try {
      const cat = run('sh', ['-c', `cat ${sourceFile}`]);
      expect(cat.status).not.toBe(0);
      expect(cat.stderr.trim()).toBe(`cat: ${sourceFile}: No such file or directory`);
      expect(listing(repo).sort()).toEqual(['node_modules', 'packages', 'test']);
      expect(listing(join(repo, 'packages'))).toEqual(['cli']);
      expect(listing(join(repo, 'packages', 'cli', 'src'))).toEqual(['google-endpoints.ts']);
      expect(listing(join(repo, 'test')).sort()).toEqual(['apps', 'builders']);
      expect(run('sh', ['-c', `find ${repo} -path '*/packages/pyric*' -print -quit`]).stdout.trim()).toBe('');

      const client = run('node', ['-e', "import('@playwright/test').then((m) => console.log(typeof m.chromium.connect))"], import.meta.dir);
      expect(client.stdout.trim()).toBe('function');
      const zod = run('node', ['-e', "import('zod').then((m) => console.log(typeof m.z.object))"], import.meta.dir);
      expect(zod.stdout.trim()).toBe('function');
    } finally {
      await namespace.stop();
    }
  }, SANDBOX_TEST_TIMEOUT_MS);
});
