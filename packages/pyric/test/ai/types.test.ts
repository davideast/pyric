/** Compile-time parity for the mirror-owned Firebase AI data types. */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';

test('mirror-owned AI data types remain mutually assignable with firebase/ai', { timeout: 30_000 }, () => {
  const contract = join(import.meta.dir, 'types.contract.ts');
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
