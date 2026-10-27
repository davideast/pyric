import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { CompatibilityRow } from '../../registry/types.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { deriveConformanceModel } from '../../src/conformance-model.ts';
import { formatRowEvidence } from '../../src/generate-docs.ts';
import { citedTestAnchors } from '../../src/test-line-anchors.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const LINKED_TEST = /blob\/main\/([^)#\s]+)#L(\d+)\)/g;

const CITED = 'packages/lib/test/cited.test.ts';

const row: CompatibilityRow = {
  id: 'lib#M1',
  surface: 'lib',
  aliases: [],
  featureKeys: [],
  rowRef: 'M1',
  rowNumber: 1,
  section: 'lib',
  api: 'readThing()',
  behavior: 'reads the thing',
  status: 'conforms',
  evidence: 'Sandbox aligned: `unit:cited.test.ts`',
  risk: [],
  riskScore: 0,
  riskReasons: [],
  automation: 'unit-backed',
  oracleObservations: [],
  conformanceTests: [CITED],
};

function anchorsFor(files: Record<string, string>): string[] {
  return citedTestAnchors([row], (path) => files[path]?.split('\n'));
}

describe('the test lines the conformance projection links to', () => {
  const original = "import { test } from 'bun:test';\n\ntest('lib#M1 reads the thing', () => {});\n";

  it('names each cited test file with the line its evidence link points at', () => {
    expect(anchorsFor({ [CITED]: original })).toEqual([`lib#M1\t${CITED}\t3`]);
  });

  it('moves when a line is added above the cited test', () => {
    const shifted = `// a new comment\n${original}`;
    expect(anchorsFor({ [CITED]: shifted })).toEqual([`lib#M1\t${CITED}\t4`]);
  });

  it('stays put when the cited file changes below the cited line', () => {
    const appended = `${original}\ntest('another case', () => {});\n`;
    expect(anchorsFor({ [CITED]: appended })).toEqual(anchorsFor({ [CITED]: original }));
  });

  it('marks a cited file that is missing', () => {
    expect(anchorsFor({})).toEqual([`lib#M1\t${CITED}\tmissing`]);
  });

  it('lists exactly the test lines the generated evidence links to, row by row', async () => {
    const model = await deriveConformanceModel();
    const cited = new Set(model.documentation.rows.flatMap((row) => row.conformanceTests));
    const linked = model.documentation.rows.flatMap((row) => {
      const evidence = formatRowEvidence(row, model.documentation.observationPaths);
      return [...evidence.matchAll(LINKED_TEST)]
        .filter(([, path]) => cited.has(path ?? ''))
        .map(([, path, line]) => `${row.id}\t${path}\t${line}`);
    });
    expect([...new Set(linked)].sort()).toEqual(citedTestAnchors(model.documentation.rows));
  }, 60_000);

  it('prints the same list when run, which is what the dist cache key hashes', () => {
    const run = Bun.spawnSync(['bun', 'src/test-line-anchors.ts'], { cwd: PACKAGE_ROOT });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trimEnd().split('\n')).toEqual(citedTestAnchors(allCompatibilityRows));
  });

  it('covers the real registry: every cited test file of every row', () => {
    const anchors = citedTestAnchors(allCompatibilityRows);
    const cited = new Set(allCompatibilityRows.flatMap((each) => each.conformanceTests.map((path) => `${each.id}\t${path}`)));
    expect(anchors.length).toBe(cited.size);
    expect(anchors.some((anchor) => anchor.includes('packages/pyric/test/database/modular/sandbox-target.test.ts\t'))).toBe(true);
    expect(anchors.every((anchor) => !anchor.endsWith('\tmissing'))).toBe(true);
  });
});
