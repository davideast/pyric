import { describe, expect, it } from 'bun:test';
import {
  booleanClauseExpressionSchema,
  boundedArraySchema,
  emitBooleanExpressionCandidates,
  emitBoundedCollectionCandidates,
  emitPrefixedIdentifierCandidates,
  emitStringMapCandidates,
  emitTypeWrongnessCandidates,
  generateMethodArgumentCases,
  methodSchema,
  objectSchema,
  prefixedIdentifierSchema,
  scalarSchema,
  stringMapSchema,
} from './argument-combinators.js';

describe('argument-combinators', () => {
  it('emits all 14 boundary wrong-type shapes with fresh mutable instances per call', () => {
    const first = emitTypeWrongnessCandidates();
    const second = emitTypeWrongnessCandidates();

    expect(first.map((entry) => entry.label)).toEqual([
      'undefined',
      'null',
      'false',
      'true',
      '0',
      '1',
      'NaN',
      '""',
      '"true"',
      '[]',
      '[""]',
      '[123]',
      '{}',
      'Object.create(null)',
    ]);

    const nanCandidate = first.find((entry) => entry.label === 'NaN');
    expect(Number.isNaN(nanCandidate?.value)).toBe(true);

    const nullProtoCandidate = first.find((entry) => entry.label === 'Object.create(null)');
    expect(Object.getPrototypeOf(nullProtoCandidate?.value)).toBeNull();

    const firstEmptyObj = first.find((entry) => entry.label === '{}')?.value as Record<string, unknown>;
    const secondEmptyObj = second.find((entry) => entry.label === '{}')?.value as Record<string, unknown>;
    firstEmptyObj.mutated = true;
    expect(secondEmptyObj.mutated).toBeUndefined();
  });

  it('emits cardinality boundaries [0, 1, MAX, MAX + 1], element wrong types, and container wrong types', () => {
    const candidates = emitBoundedCollectionCandidates({
      createValidElement: (index) => `item-${index}`,
      maxLength: 500,
    });

    const labels = candidates.map((entry) => entry.label);
    expect(labels).toContain('length=0');
    expect(labels).toContain('length=1');
    expect(labels).toContain('length=500');
    expect(labels).toContain('length=501');
    expect(labels).toContain('element[0]=null');
    expect(labels).toContain('element[1]=""');
    expect(labels).toContain('container={}');

    const maxBatch = candidates.find((entry) => entry.label === 'length=500')?.value as unknown[];
    const overBatch = candidates.find((entry) => entry.label === 'length=501')?.value as unknown[];
    expect(maxBatch).toHaveLength(500);
    expect(overBatch).toHaveLength(501);
  });

  it('emits the full cartesian product of prefixes and body atoms for prefixed identifiers', () => {
    const candidates = emitPrefixedIdentifierCandidates({
      prefixes: ['', '/topics/', '/topics/' + '/topics/', 'topics/'],
      bodies: ['', 'alerts', 'bad topic!', 'a/b'],
    });

    expect(candidates).toHaveLength(16);
    const values = candidates.map((entry) => entry.value);
    expect(values).toContain('alerts');
    expect(values).toContain('/topics/alerts');
    expect(values).toContain('/topics//topics/alerts');
    expect(values).toContain('topics/alerts');
    expect(values).toContain('/topics/');
    expect(values).toContain('bad topic!');
    expect(values).toContain('a/b');
  });

  it('emits boolean clause expressions across clause counts, operators, keyword whitespace, and quote shapes', () => {
    const candidates = emitBooleanExpressionCandidates({
      clauseCounts: [1, 2, 3, 4, 5, 6],
      operators: ['&&', '||'],
      keywordSeparators: [' ', '', '\t'],
      clauseShapes: [
        { label: 'quoted', render: (index, ws) => `'t${index}'${ws}in${ws}topics` },
        { label: 'unquoted', render: (index, ws) => `t${index}${ws}in${ws}topics` },
        { label: 'mismatched-quote', render: (index, ws) => `'t${index}"${ws}in${ws}topics` },
        { label: 'prefixed-quote', render: (index, ws) => `'/topics/t${index}'${ws}in${ws}topics` },
      ],
    });

    expect(candidates.length).toBeGreaterThanOrEqual(144);
    const values = candidates.map((entry) => entry.value);
    expect(values).toContain("'t0' in topics");
    expect(values).toContain(
      "'t0' in topics && 't1' in topics && 't2' in topics && 't3' in topics && 't4' in topics",
    );
    expect(values).toContain(
      "'t0' in topics && 't1' in topics && 't2' in topics && 't3' in topics && 't4' in topics && 't5' in topics",
    );
    expect(values).toContain("'t0'intopics");
    expect(values).toContain("'t0'\tin\ttopics");
    expect(values).toContain('t0 in topics');
    expect(values).toContain('\'t0" in topics');
    expect(values).toContain("'/topics/t0' in topics");
  });

  it('emits string-map candidates covering valid strings, all wrong value types, non-object containers, and size caps', () => {
    const candidates = emitStringMapCandidates({
      sampleKey: 'k',
      validValue: 'ok',
      maxByteLength: 10,
    });

    const labels = candidates.map((entry) => entry.label);
    expect(labels).toContain('valid-map');
    expect(labels).toContain('value=1');
    expect(labels).toContain('value=true');
    expect(labels).toContain('value={}');
    expect(labels).toContain('value=null');
    expect(labels).toContain('container=[]');
    expect(labels).toContain('bytes=10');
    expect(labels).toContain('bytes=11');
  });

  it('expands a multi-parameter method schema while holding unmutated parameters at valid baselines', () => {
    const schema = methodSchema({
      name: 'sampleSend',
      parameters: [
        {
          name: 'payload',
          validValue: () => ({ topic: 'alerts', data: { item: '1' } }),
          schema: objectSchema({
            validBase: () => ({ topic: 'alerts' }),
            fields: {
              topic: prefixedIdentifierSchema({
                prefixes: ['', '/topics/'],
                bodies: ['', 'alerts'],
              }),
              condition: booleanClauseExpressionSchema({
                clauseCounts: [1, 6],
                operators: ['&&'],
                keywordSeparators: [' ', ''],
                clauseShapes: [
                  { label: 'quoted', render: (index, ws) => `'t${index}'${ws}in${ws}topics` },
                ],
                mutuallyExclusiveWith: ['topic'],
              }),
              data: stringMapSchema({
                sampleKey: 'item',
                validValue: '1',
              }),
            },
          }),
        },
        {
          name: 'dryRun',
          validValue: () => false,
          schema: scalarSchema(),
        },
        {
          name: 'tokens',
          validValue: () => ['tok-0'],
          schema: boundedArraySchema({
            createValidElement: (index) => `tok-${index}`,
            maxLength: 3,
          }),
        },
      ],
    });

    const cases = generateMethodArgumentCases(schema);
    expect(cases.length).toBeGreaterThan(40);

    const dryRunString = cases.find((entry) => entry.label === 'dryRun="true"');
    expect(dryRunString?.args[0]).toEqual({ topic: 'alerts', data: { item: '1' } });
    expect(dryRunString?.args[1]).toBe('true');
    expect(dryRunString?.args[2]).toEqual(['tok-0']);

    const condCase = cases.find((entry) => entry.label.startsWith('payload.condition=expr:'));
    const condPayload = condCase?.args[0] as Record<string, unknown>;
    expect(condPayload.topic).toBeUndefined();
    expect(typeof condPayload.condition).toBe('string');
  });
});
