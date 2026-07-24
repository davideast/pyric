import { beforeAll, describe, expect, it } from 'bun:test';
import type { CompatibilityRow } from '../../registry/types.ts';
import { deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import {
  formatRowEvidence,
  consolidatedGapSections,
} from '../../src/generate-docs.ts';

let model: ConformanceModel;
beforeAll(async () => {
  model = await deriveConformanceModel();
}, 60_000);

describe('evidence linking and validation', () => {
  it('acceptance example: rtdb-modular#144 orderByValue() divergence links observation and exact test line number (#L51)', () => {
    const row = model.documentation.rows.find((r) => r.id === 'rtdb-modular#144');
    expect(row).toBeDefined();
    const formatted = formatRowEvidence(row!, model.documentation.observationPaths);
    
    expect(formatted).toContain('https://github.com/davideast/pyric/blob/main/packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json');
    expect(formatted).toContain('https://github.com/davideast/pyric/blob/main/packages/pyric/test/database/modular/oracle-conformance-queries.test.ts#L51');
  });

  it('appends trailing structured links with line hashes when items are not mentioned in prose', () => {
    const row: CompatibilityRow = {
      id: 'test#1',
      surface: 'test',
      aliases: [],
      featureKeys: ['name', 'version'],
      rowRef: '1',
      rowNumber: 1,
      section: 'test',
      api: 'test',
      behavior: 'test',
      status: 'conforms',
      evidence: 'Some general evidence prose without direct references.',
      risk: [],
      riskScore: 0,
      riskReasons: [],
      automation: 'unit-backed',
      oracleObservations: ['rtdb-modular-orderbyvalue-numeric'],
      conformanceTests: ['packages/conformance/package.json'],
    };

    const formatted = formatRowEvidence(row, model.documentation.observationPaths);
    expect(formatted).toContain('(Structured evidence: [');
    expect(formatted).toContain('https://github.com/davideast/pyric/blob/main/packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json');
    expect(formatted).toMatch(/https:\/\/github\.com\/davideast\/pyric\/blob\/main\/packages\/conformance\/package\.json#L\d+/);
  });

  it('renders target="_blank" rel="noopener noreferrer" anchor elements in consolidated gap disclosures', () => {
    const row = model.documentation.rows.find((r) => r.id === 'rtdb-modular#144');
    expect(row).toBeDefined();
    const gaps = consolidatedGapSections([row!], model.documentation.observationPaths);
    expect(gaps).toContain('<a href="https://github.com/davideast/pyric/blob/main/packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json" target="_blank" rel="noopener noreferrer">');
  });

  it('throws when structured evidence points to a non-existent file or untracked observation', () => {
    const badObsRow: CompatibilityRow = {
      id: 'test#bad1',
      surface: 'test',
      aliases: [],
      featureKeys: ['test'],
      rowRef: 'bad1',
      rowNumber: 2,
      section: 'test',
      api: 'test',
      behavior: 'test',
      status: 'conforms',
      evidence: '`non-existent-obs`',
      risk: [],
      riskScore: 0,
      riskReasons: [],
      automation: 'oracle-backed',
      oracleObservations: ['non-existent-obs'],
      conformanceTests: [],
    };
    expect(() => formatRowEvidence(badObsRow, model.documentation.observationPaths)).toThrow('targets untracked observation');

    const badTestRow: CompatibilityRow = {
      id: 'test#bad2',
      surface: 'test',
      aliases: [],
      featureKeys: ['test'],
      rowRef: 'bad2',
      rowNumber: 3,
      section: 'test',
      api: 'test',
      behavior: 'test',
      status: 'conforms',
      evidence: '`unit:nonexistent.test.ts`',
      risk: [],
      riskScore: 0,
      riskReasons: [],
      automation: 'unit-backed',
      oracleObservations: [],
      conformanceTests: ['packages/pyric/test/nonexistent.test.ts'],
    };
    expect(() => formatRowEvidence(badTestRow, model.documentation.observationPaths)).toThrow('targets untracked test file');
  });
});
