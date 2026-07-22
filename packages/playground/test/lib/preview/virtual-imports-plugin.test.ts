import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import { synthesizeVirtualModule } from '../../../src/lib/preview/virtual-imports-plugin';

describe('firebase/database preview exports', () => {
  it('declares every newly supported database binding', () => {
    const names = [
      'onChildAdded',
      'onChildChanged',
      'onDisconnect',
      'OnDisconnect',
      'goOffline',
      'goOnline',
    ] as const;
    const source = synthesizeVirtualModule('firebase/database');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toHaveLength(0);

    const module = ts.createSourceFile(
      'firebase-database.virtual.js',
      source,
      ts.ScriptTarget.ESNext,
      false,
      ts.ScriptKind.JS,
    );
    const exports = module.statements.flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) return [];
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) return [];
      return statement.declarationList.declarations.flatMap((declaration) =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
      );
    });
    expect(exports).toEqual(expect.arrayContaining(names));
  });
});
