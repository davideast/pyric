import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertOperationArguments } from '../../../src/serve/worker/inbound-validation/operation-arguments.js';

const operationArgumentsPath = fileURLToPath(
  new URL('../../../src/serve/worker/inbound-validation/operation-arguments.ts', import.meta.url),
);

/** Case labels that repeat an earlier label in the same switch, as `label (line)`. */
function repeatedCaseLabels(path: string): string[] {
  const text = ts.sys.readFile(path);
  if (text === undefined) throw new Error(`Cannot read ${path}`);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const repeated: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      const seen = new Set<string>();
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        const label = clause.expression.getText(source);
        const line = source.getLineAndCharacterOfPosition(clause.getStart(source)).line + 1;
        if (seen.has(label)) repeated.push(`${label} (${line})`);
        seen.add(label);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return repeated;
}

test('operation argument validation has one case clause per method', () => {
  // A repeated label is never evaluated, so a method listed twice has one live shape check and one dead one.
  expect(repeatedCaseLabels(operationArgumentsPath)).toEqual([]);
});

const op = (method: string, fields: Record<string, unknown>) => ({ t: 'op', id: 'call', method, ...fields });

const storageArgumentShapes = [
  {
    method: 'storage.abortUpload',
    valid: { uploadId: 'upload-1' },
    malformed: [{}, { uploadId: 7 }],
  },
  {
    method: 'storage.finishUpload',
    valid: { uploadId: 'upload-1' },
    malformed: [{}, { uploadId: null }],
  },
  {
    method: 'storage.putPart',
    valid: { uploadId: 'upload-1', partIndex: 0, dataB64: 'AAEC' },
    malformed: [{ partIndex: 0, dataB64: 'AAEC' }, { uploadId: 'upload-1', partIndex: '0', dataB64: 'AAEC' }, { uploadId: 'upload-1', partIndex: 0 }],
  },
  {
    method: 'storage.beginUpload',
    valid: { path: 'photos/cat.png', size: 3, contentType: 'image/png', metadata: { cacheControl: 'no-cache' } },
    malformed: [{ path: 'photos/cat.png' }, { path: 'photos/cat.png', size: 3, contentType: 5 }, { path: 'photos/cat.png', size: 3, metadata: 'x' }],
  },
  {
    method: 'storage.getBytes',
    valid: { path: 'photos/cat.png', offset: 0, length: 3, expectedGeneration: '1' },
    malformed: [{ path: 'photos/cat.png', offset: '0' }, { path: 'photos/cat.png', expectedGeneration: 1 }],
  },
  {
    method: 'storage.setMetadata',
    valid: { path: 'photos/cat.png', patch: { settable: { contentType: 'image/png' }, customMetadata: { owner: null } } },
    malformed: [{ path: 'photos/cat.png' }, { path: 'photos/cat.png', patch: { settable: { contentType: 1 } } }],
  },
];

for (const { method, valid, malformed } of storageArgumentShapes) {
  test(`${method} accepts the protocol argument shape`, () => {
    expect(() => assertOperationArguments(op(method, valid))).not.toThrow();
  });

  test(`${method} refuses malformed arguments`, () => {
    for (const fields of malformed) {
      expect(() => assertOperationArguments(op(method, fields))).toThrow();
    }
  });
}
