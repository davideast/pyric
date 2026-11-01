// The sandbox inventory, run against a small tree built here rather than `/`.
// The socket file is one this test listens on in its own temporary directory.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityProblems, interfaceNames, inventory, IP_LINK_FAILED, linkNames, loopbackOnlyProblem, mountProblems, nameservers, parseMountinfo, socketFiles, UNLISTABLE, type InventoryInput } from './sandbox-inventory.ts';

const IS_ROOT = process.getuid?.() === 0;

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A tree shaped like a good sandbox: resolv.conf naming 127.0.0.1, /run empty, a run dir. */
function sandboxTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'builders-inventory-'));
  for (const dir of ['etc', 'run', 'usr/bin', 'work/run']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'etc/resolv.conf'), 'nameserver 127.0.0.1\noptions attempts:1\n');
  return root;
}

async function listenOn(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
}

const LOOPBACK = ['lo'];
const NO_CAPABILITIES = 'CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n';
const RO_MOUNTS = [
  '393 216 0:79 /newroot / rw,nosuid,nodev,relatime - tmpfs tmpfs rw,uid=1000',
  '394 393 8:48 /usr /usr ro,nosuid,nodev,relatime - ext4 /dev/sdd rw',
  '419 418 0:5 /null /dev/null rw,nosuid,relatime master:14 - devtmpfs none rw',
  '474 393 0:83 / /tmp rw,nosuid,nodev,relatime - tmpfs tmpfs rw',
  '480 393 8:48 /home/u/run /work rw,nosuid,nodev,relatime - ext4 /dev/sdd rw',
  '261 478 0:85 / /home/u/.cache/npm rw,relatime - overlay overlay rw,lowerdir=/home/u/.cache/npm,upperdir=/tmp/.overlay/0/upper,workdir=/tmp/.overlay/0/work',
].join('\n');

/** A good sandbox's inputs for `root`; a test overrides one field. */
function input(root: string, overrides: Partial<InventoryInput> = {}): InventoryInput {
  return { root, ownDirs: ['/work'], interfaces: LOOPBACK, status: NO_CAPABILITIES, mountinfo: RO_MOUNTS, unlistable: [], ...overrides };
}

describe('nameservers', () => {
  test('reads each nameserver line', () => {
    expect(nameservers('# comment\nnameserver 127.0.0.1\nsearch x\nnameserver 10.255.255.254\n')).toEqual(['127.0.0.1', '10.255.255.254']);
  });
});

describe('inventory', () => {
  test('passes a tree with loopback only and nothing it must not have', () => {
    expect(inventory(input(sandboxTree())).problems).toEqual([]);
  });

  test('fails with an interface besides loopback', () => {
    expect(inventory(input(sandboxTree(), { interfaces: ['lo', 'eth0'] })).problems).toEqual(['has interfaces besides loopback: lo, eth0']);
  });

  test('fails when resolv.conf names another nameserver', () => {
    const root = sandboxTree();
    writeFileSync(join(root, 'etc/resolv.conf'), 'nameserver 10.255.255.254\n');
    expect(inventory(input(root)).problems).toEqual(['/etc/resolv.conf names 10.255.255.254, not only 127.0.0.1']);
  });

  test('fails when resolv.conf names 127.0.0.1 and another nameserver', () => {
    const root = sandboxTree();
    writeFileSync(join(root, 'etc/resolv.conf'), 'nameserver 127.0.0.1\nnameserver 10.255.255.254\n');
    expect(inventory(input(root)).problems).toEqual(['/etc/resolv.conf names 127.0.0.1, 10.255.255.254, not only 127.0.0.1']);
  });

  test('fails when the inspecting process has a capability', () => {
    const status = NO_CAPABILITIES.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000200000');
    expect(inventory(input(sandboxTree(), { status })).problems).toEqual(['CapEff is 0000000000200000, not 0']);
  });

  test('fails on a host bind mounted read-write outside the run’s own directories', () => {
    const mountinfo = `${RO_MOUNTS}\n479 393 8:48 /home/u/repo /home/u/repo rw,nosuid,nodev,relatime - ext4 /dev/sdd rw`;
    expect(inventory(input(sandboxTree(), { mountinfo })).problems).toEqual(['/home/u/repo is mounted read-write (ext4)']);
  });

  // A mode-000 directory is unlistable only to a user without root: root
  // lists it anyway, so under `unshare -r` or as uid 0 these two can't plant
  // what they check, and skip.
  const unlistableTest = IS_ROOT ? test.skip : test;
  if (IS_ROOT) console.log('sandbox-inventory: skipping the two mode-000 directory tests: uid 0 can list a mode-000 directory, so they would plant nothing');

  unlistableTest('fails on a directory the walk could not list, unless it is allowed by name', () => {
    const root = sandboxTree();
    mkdirSync(join(root, 'usr/locked'), { mode: 0o000 });
    expect(inventory(input(root)).problems).toEqual([`directories the walk could not list, so could not check: ${join(root, 'usr/locked')}`]);
    expect(inventory(input(root, { unlistable: [{ pattern: /^\/usr\/locked$/, reason: 'test' }] })).problems).toEqual([]);
  });

  unlistableTest('fails on a directory the walk could not list when a non-empty allowed list does not name it', () => {
    const root = sandboxTree();
    mkdirSync(join(root, 'usr/locked'), { mode: 0o000 });
    const unlistable = [{ pattern: /^\/usr\/other$/, reason: 'test' }, ...UNLISTABLE];
    expect(inventory(input(root, { unlistable })).problems).toEqual([`directories the walk could not list, so could not check: ${join(root, 'usr/locked')}`]);
  });

  test('fails when ip -o link fails, even though Node lists loopback alone', () => {
    const interfaces = interfaceNames({ status: 1, stdout: '' }, ['lo']);
    expect(interfaces).toEqual([IP_LINK_FAILED, 'lo']);
    expect(inventory(input(sandboxTree(), { interfaces })).problems).toEqual([`has interfaces besides loopback: ${IP_LINK_FAILED}, lo`]);
  });

  test('fails when /mnt, /run/WSL or /run/user exists', () => {
    const root = sandboxTree();
    for (const dir of ['mnt', 'run/WSL', 'run/user']) mkdirSync(join(root, dir));
    expect(inventory(input(root)).problems).toEqual(['/mnt exists', '/run/WSL exists', '/run/user exists']);
  });

  test('fails on a socket file outside the run’s own directories, and not on one inside them', async () => {
    const root = sandboxTree();
    await listenOn(join(root, 'work/run/own.sock'));
    expect(inventory(input(root)).problems).toEqual([]);
    await listenOn(join(root, 'usr/bin/foreign.sock'));
    expect(inventory(input(root)).problems).toEqual([`socket files outside the run's own directories: ${join(root, 'usr/bin/foreign.sock')}`]);
  });
});

describe('socketFiles', () => {
  test('skips what it is told to and counts the directories it listed', async () => {
    const root = sandboxTree();
    await listenOn(join(root, 'run/a.sock'));
    expect(socketFiles(root, [join(root, 'run')]).sockets).toEqual([]);
    const all = socketFiles(root, []);
    expect(all.sockets).toEqual([join(root, 'run/a.sock')]);
    expect(all.walked).toBeGreaterThan(4);
  });
});

describe('linkNames and loopbackOnlyProblem', () => {
  test('reads the names ip -o link lists, without a peer suffix', () => {
    const output = '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n2: eth0@if5: <BROADCAST> mtu 1500\n3: tunl0@NONE: <NOARP> mtu 1480\n';
    expect(linkNames(output)).toEqual(['lo', 'eth0', 'tunl0']);
  });

  test('passes loopback alone, and fails loopback with another interface, another alone, or none', () => {
    expect(loopbackOnlyProblem(['lo'])).toBeUndefined();
    expect(loopbackOnlyProblem(['lo', 'eth0'])).toBe('has interfaces besides loopback: lo, eth0');
    expect(loopbackOnlyProblem(['eth0'])).toBe('has interfaces besides loopback: eth0');
    expect(loopbackOnlyProblem([])).toBe('has interfaces besides loopback: none');
  });
});

describe('capabilityProblems', () => {
  test('requires CapEff and CapBnd, both zero', () => {
    expect(capabilityProblems(NO_CAPABILITIES)).toEqual([]);
    expect(capabilityProblems('CapEff:\t0000000000000000\n')).toEqual(['CapBnd is missing from /proc/self/status']);
    expect(capabilityProblems(NO_CAPABILITIES.replace('CapBnd:\t0000000000000000', 'CapBnd:\t000001ffffffffff'))).toEqual(['CapBnd is 000001ffffffffff, not 0']);
  });
});

describe('mountProblems', () => {
  test('allows fresh file systems, device nodes, the run’s own directories and a /tmp overlay', () => {
    expect(mountProblems(parseMountinfo(RO_MOUNTS), ['/work', '/tmp'])).toEqual([]);
  });

  test('fails an overlay whose upper layer is on the host', () => {
    const line = '262 1 0:86 / /home/u/.cache/npm rw - overlay overlay rw,lowerdir=/a,upperdir=/home/u/upper,workdir=/home/u/work';
    expect(mountProblems(parseMountinfo(line), [])).toEqual(['/home/u/.cache/npm is mounted read-write (overlay)']);
  });

  test('does not take a mount at /r2 as inside the own directory /r', () => {
    const lines = ['1 1 8:48 /h/r /r rw - ext4 /dev/sdd rw', '2 1 8:48 /h/r2 /r2 rw - ext4 /dev/sdd rw', '3 1 8:48 /h/r/x /r/x rw - ext4 /dev/sdd rw'].join('\n');
    expect(mountProblems(parseMountinfo(lines), ['/r'])).toEqual(['/r2 is mounted read-write (ext4)']);  });

  test('decodes escaped mount points', () => {
    expect(parseMountinfo('1 1 8:48 /a /home/u/my\\040dir ro - ext4 /dev/sdd rw')[0]?.mountPoint).toBe('/home/u/my dir');
  });
});

describe('UNLISTABLE', () => {
  test('gives each allowed directory a reason', () => {
    for (const allowed of UNLISTABLE) expect(allowed.reason.length).toBeGreaterThan(20);
    expect(UNLISTABLE.some((allowed) => allowed.pattern.test('/usr/lib/modules/6.6.87.2-microsoft-standard-WSL2/lost+found'))).toBe(true);
    expect(UNLISTABLE.some((allowed) => allowed.pattern.test('/etc/ssl/private'))).toBe(false);
  });
});
