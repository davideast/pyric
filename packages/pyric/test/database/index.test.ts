/** Public package contract for `src/database/index.ts`. */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

import * as database from '../../src/database/index.js';

describe('pyric/database public mirror boundary', () => {
  it('does not export the legacy host and agent-tool toolkit', () => {
    const legacy = [
      'getRtdbTools',
      'createRtdbAdminTools',
      'createRtdbDataTools',
      'createRtdbRulesTools',
      'fetchDatabase',
      'initializeDatabaseApp',
      'replay',
      'GenerateIRHandler',
      'SimulateHandler',
      'WriteRulesHandler',
      'CrawlStructureHandler',
      'DataHandler',
    ];

    expect(legacy.filter((name) => name in database)).toEqual([]);
  });

  it('does not expose legacy toolkit types', () => {
    const contract = join(import.meta.dir, 'fixtures/index-contract.ts');
    const program = ts.createProgram([contract], {
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );

    expect(diagnostics).toEqual([]);
  });
});
