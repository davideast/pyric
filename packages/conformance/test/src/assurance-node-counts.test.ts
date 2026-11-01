import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assuranceNodeCountProblems,
  assuranceNodeOwners,
  loadAssuranceNodeCounts,
} from '../../src/assurance-node-counts.ts';
import { registriesByKey, rowsForSurface } from '../../registry/index.ts';

const owners = new Map([
  ['storage#1', 'storage'],
  ['storage#2', 'storage'],
  ['rules#1', 'rules'],
  ['firestore.fn.size', 'firestore-rules'],
]);
const committed = { storage: 2, rules: 1, 'firestore-rules': 1 };

/** A count directory tree in a fresh temp dir: `{ service: { file: json } }`. */
function countTree(services: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'assurance-node-counts-'));
  writeCountTree(root, services);
  return root;
}

function writeCountTree(root: string, services: Record<string, Record<string, string>>): void {
  for (const [service, files] of Object.entries(services)) {
    mkdirSync(join(root, service), { recursive: true });
    for (const [file, json] of Object.entries(files)) writeFileSync(join(root, service, file), json);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

describe('per-service assurance node counts', () => {
  it('agrees when every service matches its committed count', () => {
    expect(assuranceNodeCountProblems(owners.keys(), owners, committed)).toEqual([]);
  });

  it('fails a removed row with the service and the count directory, and leaves other services alone', () => {
    const ids = [...owners.keys()].filter((id) => id !== 'storage#2');
    expect(assuranceNodeCountProblems(ids, owners, committed)).toEqual([
      'storage: 1 assurance nodes, packages/conformance/assurance-node-counts/storage/ sums to 2 (1 removed); '
        + 'if the row change is deliberate, add packages/conformance/assurance-node-counts/storage/<pr-number>.json '
        + 'with {"delta": -1}, named for the PR number, not the issue',
    ]);
  });

  it('fails an added row with no delta file, naming the service and its directory', () => {
    const withRow = new Map([...owners, ['rules#2', 'rules']]);
    const [problem, ...rest] = assuranceNodeCountProblems(withRow.keys(), withRow, committed);
    expect(rest).toEqual([]);
    expect(problem).toStartWith('rules: 2 assurance nodes');
    expect(problem).toContain('(1 added)');
    expect(problem).toContain('packages/conformance/assurance-node-counts/rules/');
    expect(problem).toContain('{"delta": 1}');
  });

  it('fails a service with no count directory and a count directory with no service', () => {
    const withService = new Map([...owners, ['app#1', 'app']]);
    const problems = assuranceNodeCountProblems(
      [...withService.keys()].filter((id) => id !== 'rules#1'),
      withService,
      committed,
    );
    expect(problems).toEqual([
      'app: 1 assurance nodes and no committed count; '
        + 'create packages/conformance/assurance-node-counts/app/base.json with {"nodes": 1}',
      'rules: no assurance nodes, but packages/conformance/assurance-node-counts/rules/ sums to 1; '
        + 'delete packages/conformance/assurance-node-counts/rules/ if the service was removed deliberately',
    ]);
  });

  it('fails a node no service owns', () => {
    expect(assuranceNodeCountProblems([...owners.keys(), 'orphan#1'], owners, committed)).toEqual([
      "assurance node 'orphan#1' has no owning registry or rules-language snapshot",
    ]);
  });

  it('sums base.json and every delta file in one directory per service', () => {
    const dir = countTree({
      storage: { 'base.json': '{ "nodes": 2 }\n', '1479.json': '{ "delta": 3 }\n', 'drop-old-row.json': '{ "delta": -1 }\n' },
      rules: { 'base.json': '{ "nodes": 1 }\n' },
      app: { '1500.json': '{ "delta": 4 }\n' },
    });
    expect(loadAssuranceNodeCounts(dir)).toEqual({ app: 4, rules: 1, storage: 4 });
  });

  it('rejects a delta of zero', () => {
    const dir = countTree({ storage: { 'base.json': '{ "nodes": 2 }\n', '1479.json': '{ "delta": 0 }\n' } });
    expect(() => loadAssuranceNodeCounts(dir)).toThrow(
      'packages/conformance/assurance-node-counts/storage/1479.json: "delta" must be a non-zero integer',
    );
  });

  it('rejects a base count that is negative or not an integer', () => {
    const dir = countTree({ app: { 'base.json': '{ "nodes": -1 }\n' } });
    expect(() => loadAssuranceNodeCounts(dir)).toThrow(
      'packages/conformance/assurance-node-counts/app/base.json: "nodes" must be a non-negative integer',
    );
  });

  it('rejects a file name outside ^[a-z0-9-]+\\.json$', () => {
    for (const bad of ['Fix_1479.json', '1479.JSON', 'notes.md', '.json']) {
      const dir = countTree({ storage: { 'base.json': '{ "nodes": 2 }\n', [bad]: '{ "delta": 1 }\n' } });
      expect(() => loadAssuranceNodeCounts(dir)).toThrow(
        `packages/conformance/assurance-node-counts/storage/${bad}: count file names must match ^[a-z0-9-]+\\.json$`,
      );
    }
  });

  it('rejects a count file left at the top level, the layout before count directories', () => {
    const dir = countTree({ rules: { 'base.json': '{ "nodes": 1 }\n' } });
    writeFileSync(join(dir, 'storage.json'), '{ "nodes": 2 }\n');
    expect(() => loadAssuranceNodeCounts(dir)).toThrow(
      'packages/conformance/assurance-node-counts/storage.json: each service is a directory',
    );
  });

  it('rejects a symlinked count file or service directory, so nothing counts twice', () => {
    const linkedFile = countTree({ storage: { 'base.json': '{ "nodes": 2 }\n' } });
    symlinkSync(join(linkedFile, 'storage', 'base.json'), join(linkedFile, 'storage', '1479.json'));
    expect(() => loadAssuranceNodeCounts(linkedFile)).toThrow(
      'packages/conformance/assurance-node-counts/storage/1479.json: a count file must be a regular file, not a symlink or directory',
    );
    const linkedDir = countTree({ storage: { 'base.json': '{ "nodes": 2 }\n' } });
    symlinkSync(join(linkedDir, 'storage'), join(linkedDir, 'storage-copy'));
    expect(() => loadAssuranceNodeCounts(linkedDir)).toThrow(
      'packages/conformance/assurance-node-counts/storage-copy: each service is a directory',
    );
  });

  it('names the file whose JSON does not parse', () => {
    const dir = countTree({ storage: { 'base.json': '{ "nodes": 2 }\n', '1479.json': '{ "delta": 1,\n' } });
    expect(() => loadAssuranceNodeCounts(dir)).toThrow(
      'packages/conformance/assurance-node-counts/storage/1479.json: not valid JSON',
    );
  });

  it('rejects a directory whose files sum below zero', () => {
    const dir = countTree({ storage: { 'base.json': '{ "nodes": 1 }\n', '1479.json': '{ "delta": -2 }\n' } });
    expect(() => loadAssuranceNodeCounts(dir)).toThrow(
      'packages/conformance/assurance-node-counts/storage/: files sum to -1',
    );
  });

  it('merges two branches that each add one row to the same service with no conflict, and the sum checks out', () => {
    const repo = mkdtempSync(join(tmpdir(), 'assurance-node-counts-merge-'));
    const counts = join(repo, 'assurance-node-counts');
    writeCountTree(counts, { storage: { 'base.json': '{ "nodes": 2 }\n' } });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'switch', '-q', '-c', 'one');
    writeCountTree(counts, { storage: { '1501.json': '{ "delta": 1 }\n' } });
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add storage#3');
    git(repo, 'switch', '-q', '-c', 'two', 'main');
    writeCountTree(counts, { storage: { '1502.json': '{ "delta": 1 }\n' } });
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add storage#4');
    git(repo, 'switch', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge one and two', 'one', 'two');

    expect(loadAssuranceNodeCounts(counts)).toEqual({ storage: 4 });
    const merged = new Map([
      ['storage#1', 'storage'], ['storage#2', 'storage'], ['storage#3', 'storage'], ['storage#4', 'storage'],
    ]);
    expect(assuranceNodeCountProblems(merged.keys(), merged, loadAssuranceNodeCounts(counts))).toEqual([]);
  });

  it('fails against the committed counts when a real registry row is dropped', () => {
    const realOwners = assuranceNodeOwners();
    const dropped = rowsForSurface(registriesByKey.storage!)[0]!.id;
    const problems = assuranceNodeCountProblems(
      [...realOwners.keys()].filter((id) => id !== dropped),
      realOwners,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith('storage: ');
    expect(problems[0]).toContain('(1 removed)');
    expect(problems[0]).toContain('packages/conformance/assurance-node-counts/storage/');
  });
});
