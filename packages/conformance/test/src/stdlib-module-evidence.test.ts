import { describe, expect, test } from 'bun:test';
import { STDLIB_MODULE_EVIDENCE } from '../../../pyric/src/rules/modules/stdlib-services.generated.ts';
import { loadObservations } from '../../observations/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { validateStdlibModuleEvidence } from '../../src/stdlib-module-evidence.ts';

describe('stdlib module evidence integrity', () => {
  test('every generated evidence id resolves to eligible, linked oracle evidence', () => {
    expect(validateStdlibModuleEvidence(
      STDLIB_MODULE_EVIDENCE,
      allCompatibilityRows,
      loadObservations(),
    )).toEqual([]);
  });

  test('rejects missing, ineligible, and unlinked evidence rows', () => {
    const rows = [{
      id: 'storage-rules#1',
      status: 'bug',
      automation: 'unit-backed',
      oracleObservations: ['capture'],
    }];
    const observations = [{ name: 'capture', rowIds: [] }];
    expect(validateStdlibModuleEvidence(
      { module: ['storage-rules#1', 'storage-rules#999'] },
      rows,
      observations,
    )).toEqual([
      "module: evidence 'storage-rules#1' must be conforms + oracle-backed",
      "module: observation 'capture' does not link back to 'storage-rules#1'",
      "module: evidence 'storage-rules#999' is not a canonical registry row",
    ]);
  });
});
