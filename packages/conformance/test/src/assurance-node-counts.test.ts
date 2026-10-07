import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

describe('per-service assurance node counts', () => {
  it('agrees when every service matches its committed count', () => {
    expect(assuranceNodeCountProblems(owners.keys(), owners, committed)).toEqual([]);
  });

  it('fails a removed row with the service and the count file to update, and leaves other services alone', () => {
    const ids = [...owners.keys()].filter((id) => id !== 'storage#2');
    expect(assuranceNodeCountProblems(ids, owners, committed)).toEqual([
      'storage: 1 assurance nodes, packages/conformance/assurance-node-counts/storage.json commits 2 (1 removed); '
        + 'if the row change is deliberate, set "nodes" to 1 in packages/conformance/assurance-node-counts/storage.json',
    ]);
  });

  it('fails an added row in one service', () => {
    const withRow = new Map([...owners, ['rules#2', 'rules']]);
    const [problem, ...rest] = assuranceNodeCountProblems(withRow.keys(), withRow, committed);
    expect(rest).toEqual([]);
    expect(problem).toStartWith('rules: 2 assurance nodes');
    expect(problem).toContain('(1 added)');
    expect(problem).toContain('packages/conformance/assurance-node-counts/rules.json');
  });

  it('fails a service with no count file and a count file with no service', () => {
    const withService = new Map([...owners, ['app#1', 'app']]);
    const { rules: _dropped, ...withoutRules } = committed;
    const problems = assuranceNodeCountProblems(
      [...withService.keys()].filter((id) => id !== 'rules#1'),
      withService,
      { ...withoutRules, rules: 1 },
    );
    expect(problems).toEqual([
      'app: 1 assurance nodes and no committed count; create packages/conformance/assurance-node-counts/app.json with {"nodes": 1}',
      'rules: no assurance nodes, but packages/conformance/assurance-node-counts/rules.json commits 1; '
        + 'delete packages/conformance/assurance-node-counts/rules.json if the service was removed deliberately',
    ]);
  });

  it('fails a node no service owns', () => {
    expect(assuranceNodeCountProblems([...owners.keys(), 'orphan#1'], owners, committed)).toEqual([
      "assurance node 'orphan#1' has no owning registry or rules-language snapshot",
    ]);
  });

  it('reads one count file per service, keyed by filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assurance-node-counts-'));
    writeFileSync(join(dir, 'storage.json'), '{ "nodes": 2 }\n');
    writeFileSync(join(dir, 'rules.json'), '{ "nodes": 1 }\n');
    expect(loadAssuranceNodeCounts(dir)).toEqual({ rules: 1, storage: 2 });
    writeFileSync(join(dir, 'app.json'), '{ "nodes": -1 }\n');
    expect(() => loadAssuranceNodeCounts(dir)).toThrow('packages/conformance/assurance-node-counts/app.json');
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
    expect(problems[0]).toContain('packages/conformance/assurance-node-counts/storage.json');
  });
});
