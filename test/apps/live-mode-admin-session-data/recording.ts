/**
 * Offline replay recording for `test/apps/live-mode-admin-session-data`:
 * google.firestore.v1 gRPC exchanges, RTDB v5 wire frames, and a browser
 * WebChannel Listen batch.
 */

export const PROJECT = 'demo-live-admin-session';
export const INSTANCE = `${PROJECT}-default-rtdb`;
export const SECRET_VALUE = 'secret-order-key';

const DATABASE = `projects/${PROJECT}/databases/(default)`;
const DOCUMENTS = `${DATABASE}/documents`;

export function buildRecording(format: string): Record<string, unknown> {
  const commitTime = { $: 'commitTime' };
  const readTime = { $: 'readTime' };
  const resumeToken = { $: 'resumeToken' };
  const transaction = { $: 'transaction' };
  const targetIds = [{ $: 'targetId' }];

  return {
    format,
    project: PROJECT,
    source: 'hand-written from google.firestore.v1 gRPC, RTDB v5, and WebChannel Listen wire formats',
    exchanges: [
      {
        kind: 'admin-firestore',
        id: 'set-ord-1',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: `${DOCUMENTS}/orders/ord-1`,
                fields: {
                  apiKey: { stringValue: SECRET_VALUE },
                  status: { stringValue: 'queued' },
                  total: { integerValue: '42' },
                },
              },
            },
          ],
        },
        responses: [{ writeResults: [{ updateTime: commitTime }], commitTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'get-ord-1',
        rpc: 'BatchGetDocuments',
        request: {
          database: DATABASE,
          documents: [`${DOCUMENTS}/orders/ord-1`],
        },
        responses: [
          {
            found: {
              name: `${DOCUMENTS}/orders/ord-1`,
              fields: {
                apiKey: { stringValue: SECRET_VALUE },
                status: { stringValue: 'queued' },
                total: { integerValue: '42' },
              },
              createTime: '2026-11-01T08:00:00.000001Z',
              updateTime: '2026-11-01T08:00:00.000001Z',
            },
            readTime,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'get-ord-missing',
        rpc: 'BatchGetDocuments',
        request: {
          database: DATABASE,
          documents: [`${DOCUMENTS}/orders/ord-missing`],
        },
        responses: [{ missing: `${DOCUMENTS}/orders/ord-missing`, readTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'update-ord-1',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: `${DOCUMENTS}/orders/ord-1`,
                fields: {
                  priority: { integerValue: '2' },
                  status: { stringValue: 'processing' },
                },
              },
              updateMask: { fieldPaths: ['priority', 'status'] },
              currentDocument: { exists: true },
            },
          ],
        },
        responses: [{ writeResults: [{ updateTime: commitTime }], commitTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'update-ord-missing',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: `${DOCUMENTS}/orders/ord-missing`,
                fields: { status: { stringValue: 'never' } },
              },
              updateMask: { fieldPaths: ['status'] },
              currentDocument: { exists: true },
            },
          ],
        },
        error: {
          code: 5,
          status: 'NOT_FOUND',
          message: `No document to update: ${DOCUMENTS}/orders/ord-missing`,
        },
      },
      {
        kind: 'admin-firestore',
        id: 'add-order',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: { $: 'autoId', name: 'addedOrder', parent: `${DOCUMENTS}/orders` },
                fields: {
                  status: { stringValue: 'added' },
                  total: { integerValue: '15' },
                },
              },
              currentDocument: { exists: false },
            },
          ],
        },
        responses: [{ writeResults: [{ updateTime: commitTime }], commitTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'get-all-orders',
        rpc: 'BatchGetDocuments',
        request: {
          database: DATABASE,
          documents: [`${DOCUMENTS}/orders/ord-2`, `${DOCUMENTS}/orders/ord-stale`],
        },
        responses: [
          {
            found: {
              name: `${DOCUMENTS}/orders/ord-2`,
              fields: {
                status: { stringValue: 'shipped' },
                total: { integerValue: '80' },
              },
              createTime: '2026-11-01T08:00:01.000001Z',
              updateTime: '2026-11-01T08:00:01.000001Z',
            },
            readTime,
          },
          { missing: `${DOCUMENTS}/orders/ord-stale`, readTime },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'batch-orders',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: `${DOCUMENTS}/orders/ord-batch`,
                fields: {
                  status: { stringValue: 'batched' },
                  total: { integerValue: '10' },
                },
              },
            },
            { delete: `${DOCUMENTS}/orders/ord-stale` },
          ],
        },
        responses: [{ writeResults: [{ updateTime: commitTime }, {}], commitTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'query-orders',
        rpc: 'RunQuery',
        request: {
          parent: DOCUMENTS,
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'total' },
                op: 'GREATER_THAN_OR_EQUAL',
                value: { integerValue: '10' },
              },
            },
          },
        },
        responses: [
          {
            document: {
              name: `${DOCUMENTS}/orders/ord-extra`,
              fields: {
                status: { stringValue: 'indexed' },
                total: { integerValue: '30' },
              },
              createTime: '2026-11-01T08:00:02.000001Z',
              updateTime: '2026-11-01T08:00:02.000001Z',
            },
            readTime,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'tx-get-ord-1',
        rpc: 'BatchGetDocuments',
        request: {
          database: DATABASE,
          documents: [`${DOCUMENTS}/orders/ord-1`],
          newTransaction: { readWrite: {} },
        },
        responses: [
          { transaction },
          {
            found: {
              name: `${DOCUMENTS}/orders/ord-1`,
              fields: {
                apiKey: { stringValue: SECRET_VALUE },
                priority: { integerValue: '2' },
                status: { stringValue: 'processing' },
                total: { integerValue: '42' },
              },
              createTime: '2026-11-01T08:00:00.000001Z',
              updateTime: '2026-11-01T08:00:00.000002Z',
            },
            readTime,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'tx-commit-ord-1',
        rpc: 'Commit',
        request: {
          database: DATABASE,
          writes: [
            {
              update: {
                name: `${DOCUMENTS}/orders/ord-1`,
                fields: {
                  previousStatus: { stringValue: 'processing' },
                  status: { stringValue: 'fulfilled' },
                },
              },
              updateMask: { fieldPaths: ['previousStatus', 'status'] },
              currentDocument: { exists: true },
            },
          ],
          transaction,
        },
        responses: [{ writeResults: [{ updateTime: commitTime }], commitTime }],
      },
      {
        kind: 'admin-firestore',
        id: 'tx-get-ord-2',
        rpc: 'BatchGetDocuments',
        request: {
          database: DATABASE,
          documents: [`${DOCUMENTS}/orders/ord-2`],
          newTransaction: { readWrite: {} },
        },
        responses: [
          { transaction },
          {
            found: {
              name: `${DOCUMENTS}/orders/ord-2`,
              fields: {
                status: { stringValue: 'shipped' },
                total: { integerValue: '80' },
              },
              createTime: '2026-11-01T08:00:01.000001Z',
              updateTime: '2026-11-01T08:00:01.000001Z',
            },
            readTime,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'tx-rollback-ord-2',
        rpc: 'Rollback',
        request: {
          database: DATABASE,
          transaction,
        },
        responses: [{}],
      },
      {
        kind: 'rtdb',
        id: 'rtdb-connect',
        instance: INSTANCE,
        events: [
          {
            t: 'c',
            d: {
              t: 'h',
              d: {
                ts: { $: 'serverTime' },
                v: '5',
                h: { $: 'host' },
                s: { $: 'session' },
              },
            },
          },
        ],
      },
      {
        kind: 'rtdb',
        id: 'rtdb-set-q1',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'p', b: { p: '/queues/q-1', d: { state: 'ready', workers: 2 } } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-update-q1',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'm', b: { p: '/queues/q-1', d: { region: 'us', workers: 3 } } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-push-item',
        instance: INSTANCE,
        as: 'owner',
        request: {
          a: 'p',
          b: {
            p: { $: 'pushId', name: 'pushedQueueItem', parent: '/queues/items' },
            d: { job: 'sync' },
          },
        },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-get-extra',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'g', b: { p: '/queues/extra', q: {} } },
        reply: { s: 'ok', d: { state: 'loaded' } },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-listen-counter',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'q', b: { p: '/counters/processed', h: { $: 'any' } } },
        events: [{ t: 'd', d: { a: 'd', b: { p: '/counters/processed', d: 4 } } }],
        reply: { s: 'ok', d: {} },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-tx-counter-stale',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'p', b: { p: '/counters/processed', d: 1, h: '' } },
        reply: { s: 'datastale', d: 'Transaction hash does not match' },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-tx-counter',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'p', b: { p: '/counters/processed', d: 5, h: { $: 'any' } } },
        reply: { s: 'ok', d: '' },
      },
      {
        kind: 'rtdb',
        id: 'rtdb-listen-aborted',
        instance: INSTANCE,
        as: 'owner',
        request: { a: 'q', b: { p: '/counters/aborted', h: { $: 'any' } } },
        reply: { s: 'ok', d: {} },
      },
      {
        kind: 'listen',
        id: 'client-read-catalog',
        target: { documents: { documents: [`${DOCUMENTS}/catalog/cat-1`] } },
        batches: [
          {
            messages: [
              { targetChange: { targetChangeType: 'ADD', targetIds } },
              {
                documentChange: {
                  document: {
                    name: `${DOCUMENTS}/catalog/cat-1`,
                    fields: { label: { stringValue: 'Widget' } },
                    createTime: '2026-11-01T08:05:00.000000Z',
                    updateTime: '2026-11-01T08:05:00.000000Z',
                  },
                  targetIds,
                },
              },
              { targetChange: { targetChangeType: 'CURRENT', targetIds, resumeToken, readTime } },
              { targetChange: { targetChangeType: 'NO_CHANGE', resumeToken, readTime } },
            ],
          },
        ],
      },
    ],
  };
}
