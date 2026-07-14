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

    const inspected = inspectOnValueCreated({
      supported,
      prefixGlob,
      recursiveGlob,
      instanceGlob,
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
    ]);
  });
});
