import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  discoverOnValueCreated,
  inspectOnValueCreated,
} from '../../src/functions-rtdb/discovery.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');

describe('discoverOnValueCreated', () => {
  test('recognizes real v2 RTDB create callables by endpoint metadata', () => {
    const { onValueCreated, onValueUpdated } = databaseFunctions;
    const created = onValueCreated('/messages/{pushId}/original', () => undefined);
    const updated = onValueUpdated('/messages/{pushId}/original', () => undefined);

    expect(discoverOnValueCreated({ created, updated, helper: () => undefined })).toEqual([
      {
        exportName: 'created',
        reference: 'messages/{pushId}/original',
        instance: '*',
        callable: created,
      },
    ]);
  });

  test('recursively discovers grouped exports using Firebase endpoint names', () => {
    const { onValueCreated } = databaseFunctions;
    const grouped = onValueCreated('/messages/{id}', () => undefined);

    expect(discoverOnValueCreated({ messages: { makeUppercase: grouped } })).toEqual([
      {
        exportName: 'messages-makeUppercase',
        reference: 'messages/{id}',
        instance: '*',
        callable: grouped,
      },
    ]);
  });

  test('discovers every Firebase name for aliased grouped exports', () => {
    const { onValueCreated } = databaseFunctions;
    const grouped = { run: onValueCreated('/messages/{id}', () => undefined) };

    expect(discoverOnValueCreated({ first: grouped, second: grouped }).map((trigger) => (
      trigger.exportName
    ))).toEqual(['first-run', 'second-run']);
  });

  test('stops recursive export cycles without suppressing other endpoints', () => {
    const { onValueCreated } = databaseFunctions;
    const grouped: Record<string, unknown> = {
      run: onValueCreated('/messages/{id}', () => undefined),
    };
    grouped.self = grouped;

    expect(discoverOnValueCreated({ grouped }).map((trigger) => trigger.exportName)).toEqual([
      'grouped-run',
    ]);
  });

  test('does not activate endpoints Firebase marks omit from emulation', () => {
    const { onValueCreated } = databaseFunctions;
    const omitted = onValueCreated({
      ref: '/messages/{id}',
      omit: true,
    }, () => undefined);

    expect(inspectOnValueCreated({ omitted })).toEqual({
      triggers: [],
      unsupported: [{
        exportName: 'omitted',
        eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
      }],
    });
  });

  test('keeps a trigger-specific instance and region for the raw event', () => {
    const { onValueCreated } = databaseFunctions;
    const regional = onValueCreated({
      ref: '/messages/{id}',
      instance: 'regional-rtdb',
      region: 'europe-west1',
    }, () => undefined);

    expect(discoverOnValueCreated({ regional })).toEqual([{
      exportName: 'regional',
      reference: 'messages/{id}',
      instance: 'regional-rtdb',
      location: 'europe-west1',
      callable: regional,
    }]);
  });

  test('reports Firebase path patterns outside the exact and single-wildcard slice', () => {
    const { onValueCreated } = databaseFunctions;
    const supported = onValueCreated('/messages/{id}', () => undefined);
    const prefixGlob = onValueCreated('/messages/{id=prefix/*}', () => undefined);
    const recursiveGlob = onValueCreated('/messages/{id=**}', () => undefined);
    const instanceGlob = onValueCreated({
      ref: '/messages/{id}',
      instance: 'db-*',
    }, () => undefined);
    const anonymousGlob = onValueCreated('/messages/*', () => undefined);
    const prefixGlobLiteral = onValueCreated('/messages/prefix-*', () => undefined);

    const inspected = inspectOnValueCreated({
      supported,
      prefixGlob,
      recursiveGlob,
      instanceGlob,
      anonymousGlob,
      prefixGlobLiteral,
    });

    expect(inspected.triggers.map((trigger) => trigger.exportName)).toEqual(['supported']);
    expect(inspected.unsupported).toEqual([
      {
        exportName: 'prefixGlob',
        eventType: 'google.firebase.database.ref.v1.created (unsupported ref pattern: messages/{id=prefix/*})',
      },
      {
        exportName: 'recursiveGlob',
        eventType: 'google.firebase.database.ref.v1.created (unsupported ref pattern: messages/{id=**})',
      },
      {
        exportName: 'instanceGlob',
        eventType: 'google.firebase.database.ref.v1.created (unsupported instance pattern: db-*)',
      },
      {
        exportName: 'anonymousGlob',
        eventType: 'google.firebase.database.ref.v1.created (unsupported ref pattern: messages/*)',
      },
      {
        exportName: 'prefixGlobLiteral',
        eventType: 'google.firebase.database.ref.v1.created (unsupported ref pattern: messages/prefix-*)',
      },
    ]);
  });

  test('accepts the complete named single-segment Eventarc capture grammar', () => {
    const { onValueCreated } = databaseFunctions;
    const underscore = onValueCreated('/messages/{_id}', () => undefined);
    const numeric = onValueCreated('/messages/{123}', () => undefined);
    const explicitSingle = onValueCreated('/messages/{id=*}', () => undefined);

    expect(discoverOnValueCreated({ underscore, numeric, explicitSingle }).map((trigger) => ({
      exportName: trigger.exportName,
      reference: trigger.reference,
    }))).toEqual([
      { exportName: 'underscore', reference: 'messages/{_id}' },
      { exportName: 'numeric', reference: 'messages/{123}' },
      { exportName: 'explicitSingle', reference: 'messages/{id=*}' },
    ]);
  });
});
