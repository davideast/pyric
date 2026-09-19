import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('collection references can be observed, read, and assigned as queries', { timeout: 30_000 }, () => {
  const configPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
  expect(config.errors).toEqual([]);
  const options = { ...config.options, noEmit: true };
  const probePath = fileURLToPath(new URL('../../../src/collection-query-probe.ts', import.meta.url));
  const probe = `
    import { collection, getDocs, onSnapshot, type Firestore, type Query } from './firestore/index.js';
    declare const db: Firestore;
    onSnapshot(collection(db, 'users'), () => {});
    getDocs(collection(db, 'users'));
    const q: Query = collection(db, 'users');
  `;
  // Compile the public source entry without depending on a previous build.
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const isProbe = path === probePath;
    if (isProbe) return ts.createSourceFile(path, probe, languageVersion, true);
    return getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([probePath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
  expect(diagnostics).toEqual([]);
});
