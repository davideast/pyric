import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertOperationArguments } from '../../../src/serve/worker/inbound-validation/operation-arguments.js';
import { assertListenerOwners } from '../../../src/serve/worker/inbound-validation/listener-owners.js';
import { refuseInvalidInboundMessage } from '../../../src/serve/worker/inbound-validation.js';

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

test('a listener frame owner may carry the application frames around it', () => {
  const frame = { file: '/src/db.js', line: 5, column: 10, function: 'watch' };
  const owner = { kind: 'frame', ...frame, stack: [frame, { file: '/src/room-list.js', line: 5 }] };
  expect(() => assertListenerOwners([owner])).not.toThrow();
});

test('a listener frame owner refuses a malformed frame stack', () => {
  const frame = { kind: 'frame', file: '/src/db.js', line: 5 };
  for (const stack of ['/src/db.js:5', [{ file: '/src/db.js' }], [{ file: 5, line: 5 }], [{ file: '/src/db.js', line: 5, function: 1 }]]) {
    expect(() => assertListenerOwners([{ ...frame, stack }])).toThrow('owner.stack');
  }
});

test('an observe frame keeps its call when its session data is unreadable, and only the data is removed', () => {
  const posted: unknown[] = [];
  const port = { postMessage: (message: unknown) => posted.push(message) } as never;
  const call = { service: 'firestore', method: 'getDoc', path: 'items/1', at: 1, outcome: { status: 'ok' } };
  const malformed: Record<string, unknown> = { t: 'observe', id: 'o-1', call, sessionData: { firestore: [{ kind: 'set', path: 'items', data: {} }] } };
  const oversized: Record<string, unknown> = { t: 'observe', id: 'o-2', call, sessionData: { firestore: [{ kind: 'set', path: 'items/1', data: { blob: 'z'.repeat(1_100_000) } }] } };
  const valid: Record<string, unknown> = { t: 'observe', id: 'o-3', call, sessionData: { firestore: [{ kind: 'set', path: 'items/1', data: { n: 1 } }] } };

  expect(refuseInvalidInboundMessage(port, malformed)).toBe(false);
  expect(refuseInvalidInboundMessage(port, oversized)).toBe(false);
  expect(refuseInvalidInboundMessage(port, valid)).toBe(false);
  expect(posted).toEqual([]);
  expect('sessionData' in malformed).toBe(false);
  expect('sessionData' in oversized).toBe(false);
  expect(valid.sessionData).toEqual({ firestore: [{ kind: 'set', path: 'items/1', data: { n: 1 } }] });
});

test('an observe frame with a malformed call is still refused', () => {
  const posted: Array<{ ok?: boolean }> = [];
  const port = { postMessage: (message: { ok?: boolean }) => posted.push(message) } as never;
  expect(refuseInvalidInboundMessage(port, { t: 'observe', id: 'o-4', call: { service: 'firestore' } })).toBe(true);
  expect(posted[0]?.ok).toBe(false);
});
