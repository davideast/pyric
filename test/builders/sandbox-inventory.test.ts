// The sandbox inventory, run against a small tree built here rather than `/`.
// The socket file is one this test listens on in its own temporary directory.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, nameservers, socketFiles } from './sandbox-inventory.ts';

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

describe('nameservers', () => {
  test('reads each nameserver line', () => {
    expect(nameservers('# comment\nnameserver 127.0.0.1\nsearch x\nnameserver 10.255.255.254\n')).toEqual(['127.0.0.1', '10.255.255.254']);
  });
});

describe('inventory', () => {
  test('passes a tree with loopback only and nothing it must not have', () => {
    expect(inventory({ root: sandboxTree(), ownDirs: ['/work'], interfaces: LOOPBACK }).problems).toEqual([]);
  });

  test('fails with an interface besides loopback', () => {
    expect(inventory({ root: sandboxTree(), ownDirs: [], interfaces: ['lo', 'eth0'] }).problems).toEqual(['interfaces besides loopback: lo, eth0']);
  });

  test('fails when resolv.conf names another nameserver', () => {
    const root = sandboxTree();
    writeFileSync(join(root, 'etc/resolv.conf'), 'nameserver 10.255.255.254\n');
    expect(inventory({ root, ownDirs: [], interfaces: LOOPBACK }).problems).toEqual(['/etc/resolv.conf names 10.255.255.254, not only 127.0.0.1']);
  });

  test('fails when /mnt, /run/WSL or /run/user exists', () => {
    const root = sandboxTree();
    for (const dir of ['mnt', 'run/WSL', 'run/user']) mkdirSync(join(root, dir));
    expect(inventory({ root, ownDirs: [], interfaces: LOOPBACK }).problems).toEqual(['/mnt exists', '/run/WSL exists', '/run/user exists']);
  });

  test('fails on a socket file outside the run’s own directories, and not on one inside them', async () => {
    const root = sandboxTree();
    await listenOn(join(root, 'work/run/own.sock'));
    expect(inventory({ root, ownDirs: ['/work'], interfaces: LOOPBACK }).problems).toEqual([]);
    await listenOn(join(root, 'usr/bin/foreign.sock'));
    expect(inventory({ root, ownDirs: ['/work'], interfaces: LOOPBACK }).problems).toEqual([`socket files outside the run's own directories: ${join(root, 'usr/bin/foreign.sock')}`]);
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
