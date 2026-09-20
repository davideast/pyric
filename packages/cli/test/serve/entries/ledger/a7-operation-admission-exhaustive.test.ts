import { beforeAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { requiresHealthyPersistence } from '../../../../src/serve/hosted/persistence-admission.js';
import { assertOperationArguments } from '../../../../src/serve/worker/inbound-validation/operation-arguments.js';

const boundaries = [
  { name: 'persistence admission', path: 'hosted/persistence-admission.ts' },
  { name: 'operation arguments', path: 'worker/inbound-validation/operation-arguments.ts' },
];
const sourcePath = (path: string) => fileURLToPath(new URL(`../../../../src/serve/${path}`, import.meta.url));
const futureMethod = 'rtdb.futureMutation';

// A wire payload can reach a JavaScript caller without satisfying the TS union.
const unknownOperation = JSON.parse(`{"t":"op","id":"unknown","method":"${futureMethod}","path":"notes/example","value":{"title":"Example"}}`);

test('persistence admission refuses an unknown mutation instead of bypassing the health gate', () => {
  expect(() => requiresHealthyPersistence(unknownOperation)).toThrow();
});

test('argument validation refuses an unknown mutation instead of accepting it', () => {
  expect(() => assertOperationArguments(unknownOperation)).toThrow();
});

test('known reads remain admitted and known writes still require healthy persistence', () => {
  const read = { t: 'op', id: 'read', method: 'getDoc', path: 'notes/example' } as const;
  const firestoreWrite = { t: 'op', id: 'write', method: 'setDoc', path: 'notes/example', data: { title: 'Example' } } as const;
  const databaseWrite = { t: 'op', id: 'database-write', method: 'rtdb.set', path: '/notes/example', value: { title: 'Example' } } as const;
  expect(requiresHealthyPersistence(read)).toBe(false);
  expect(requiresHealthyPersistence(firestoreWrite)).toBe(true);
  expect(requiresHealthyPersistence(databaseWrite)).toBe(true);
  for (const message of [read, firestoreWrite, databaseWrite]) {
    expect(() => assertOperationArguments(message)).not.toThrow();
  }
});

/** Compile real modules, changing only the protocol union in the compiler's view. */
function admissionDiagnostics(extendProtocol: boolean): string[][] {
  const configPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
  expect(config.errors).toEqual([]);
  const options = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const protocolPath = sourcePath('worker/protocol.ts');
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const original = getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    const extendsThisFile = extendProtocol && path === protocolPath;
    const keepsOriginal = !extendsThisFile || original === undefined;
    if (keepsOriginal) return original;
    const declaration = original.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'OpMessage');
    const isMissingDeclaration = declaration === undefined || !ts.isTypeAliasDeclaration(declaration);
    if (isMissingDeclaration) throw new Error('OpMessage type declaration is missing.');
    const source = original.text;
    const start = declaration.type.getStart(original);
    const end = declaration.type.end;
    const extendedType = `(${source.slice(start, end)}) | { t: 'op'; id: string; method: '${futureMethod}'; path: string; value: unknown }`;
    const extended = source.slice(0, start) + extendedType + source.slice(end);
    return ts.createSourceFile(path, extended, languageVersion, true);
  };
  const program = ts.createProgram(boundaries.map(boundary => sourcePath(boundary.path)), options, host);
  return boundaries.map(boundary => {
    const source = program.getSourceFile(sourcePath(boundary.path));
    if (!source) throw new Error(`Missing compiler input: ${boundary.path}`);
    return program.getSemanticDiagnostics(source)
      .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  });
}

let baseline: string[][];
let extended: string[][];
beforeAll(() => {
  baseline = admissionDiagnostics(false);
  extended = admissionDiagnostics(true);
}, 30_000);

test('both admission modules typecheck with the current protocol', () => {
  expect(baseline).toEqual([[], []]);
});

for (const [index, boundary] of boundaries.entries()) {
  test(`adding a protocol mutation requires explicit handling in ${boundary.name}`, () => {
    const errors = extended[index]!;
    expect(errors.some(message => message.includes(futureMethod)), errors.join('\n')).toBe(true);
  });
}
