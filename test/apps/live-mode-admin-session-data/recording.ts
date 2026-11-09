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
const COMMIT_TIME = { $: 'commitTime' };
const READ_TIME = { $: 'readTime' };
const RESUME_TOKEN = { $: 'resumeToken' };
const TRANSACTION = { $: 'transaction' };
const TARGET_IDS = [{ $: 'targetId' }];

function commitExchange(
  id: string,
  writes: readonly Record<string, unknown>[],
  writeResults: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'admin-firestore',
    id,
    rpc: 'Commit',
    request: { database: DATABASE, writes, ...extra },
    responses: [{ writeResults, commitTime: COMMIT_TIME }],
  };
}

function rtdbExchange(
  id: string,
  action: string,
  body: Record<string, unknown>,
  reply: Record<string, unknown> = { s: 'ok', d: '' },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'rtdb',
    id,
    instance: INSTANCE,
    as: 'owner',
    request: { a: action, b: body },
    reply,
    ...extra,
  };
}

export function buildRecording(format: string): Record<string, unknown> {
  return {
    format,
    project: PROJECT,
    source: 'hand-written from google.firestore.v1 gRPC, RTDB v5, and WebChannel Listen wire formats',
    exchanges: [
      commitExchange(
        'set-ord-1',
        [
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
        [{ updateTime: COMMIT_TIME }],
      ),
      {
        kind: 'admin-firestore',
        id: 'get-ord-1',
        rpc: 'BatchGetDocuments',
        request: { database: DATABASE, documents: [`${DOCUMENTS}/orders/ord-1`] },
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
            readTime: READ_TIME,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'get-ord-missing',
        rpc: 'BatchGetDocuments',
        request: { database: DATABASE, documents: [`${DOCUMENTS}/orders/ord-missing`] },
        responses: [{ missing: `${DOCUMENTS}/orders/ord-missing`, readTime: READ_TIME }],
      },
      commitExchange(
        'create-ord-created',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-created`,
              fields: { status: { stringValue: 'created' }, total: { integerValue: '12' } },
            },
            currentDocument: { exists: false },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
      commitExchange(
        'set-ord-merge-base',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-merge`,
              fields: { status: { stringValue: 'base' }, total: { integerValue: '20' } },
            },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
      commitExchange(
        'set-ord-merge-true',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-merge`,
              fields: { tier: { stringValue: 'gold' } },
            },
            updateMask: { fieldPaths: ['tier'] },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
      commitExchange(
        'set-ord-merge-fields',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-merge`,
              fields: { status: { stringValue: 'merged' } },
            },
            updateMask: { fieldPaths: ['status'] },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
      commitExchange(
        'set-ord-temp',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-temp`,
              fields: { status: { stringValue: 'temp' }, total: { integerValue: '5' } },
            },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
      commitExchange('delete-ord-temp', [{ delete: `${DOCUMENTS}/orders/ord-temp` }], [{}]),
      commitExchange(
        'update-ord-1',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-1`,
              fields: { priority: { integerValue: '2' }, status: { stringValue: 'processing' } },
            },
            updateMask: { fieldPaths: ['priority', 'status'] },
            currentDocument: { exists: true },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
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
      commitExchange(
        'add-order',
        [
          {
            update: {
              name: { $: 'autoId', name: 'addedOrder', parent: `${DOCUMENTS}/orders` },
              fields: { status: { stringValue: 'added' }, total: { integerValue: '15' } },
            },
            currentDocument: { exists: false },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
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
              fields: { status: { stringValue: 'shipped' }, total: { integerValue: '80' } },
              createTime: '2026-11-01T08:00:01.000001Z',
              updateTime: '2026-11-01T08:00:01.000001Z',
            },
            readTime: READ_TIME,
          },
          { missing: `${DOCUMENTS}/orders/ord-stale`, readTime: READ_TIME },
        ],
      },
      commitExchange(
        'batch-orders',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-batch`,
              fields: { status: { stringValue: 'batched' }, total: { integerValue: '10' } },
            },
          },
          { delete: `${DOCUMENTS}/orders/ord-stale` },
        ],
        [{ updateTime: COMMIT_TIME }, {}],
      ),
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
              fields: { status: { stringValue: 'indexed' }, total: { integerValue: '30' } },
              createTime: '2026-11-01T08:00:02.000001Z',
              updateTime: '2026-11-01T08:00:02.000001Z',
            },
            readTime: READ_TIME,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'listen-live-orders',
        rpc: 'Listen',
        request: {
          query: {
            parent: DOCUMENTS,
            structuredQuery: {
              from: [{ collectionId: 'orders' }],
              where: {
                fieldFilter: {
                  field: { fieldPath: 'status' },
                  op: 'EQUAL',
                  value: { stringValue: 'live' },
                },
              },
            },
          },
        },
        batches: [
          {
            messages: [
              { targetChange: { targetChangeType: 'ADD', targetIds: TARGET_IDS } },
              {
                documentChange: {
                  document: {
                    name: `${DOCUMENTS}/orders/ord-live-1`,
                    fields: { status: { stringValue: 'live' }, total: { integerValue: '25' } },
                    createTime: '2026-11-01T08:00:03.000001Z',
                    updateTime: '2026-11-01T08:00:03.000001Z',
                  },
                  targetIds: TARGET_IDS,
                },
              },
              {
                targetChange: {
                  targetChangeType: 'CURRENT',
                  targetIds: TARGET_IDS,
                  resumeToken: RESUME_TOKEN,
                  readTime: READ_TIME,
                },
              },
            ],
          },
          {
            after: 'set-ord-live-2',
            messages: [
              {
                documentChange: {
                  document: {
                    name: `${DOCUMENTS}/orders/ord-live-2`,
                    fields: { status: { stringValue: 'live' }, total: { integerValue: '35' } },
                    createTime: COMMIT_TIME,
                    updateTime: COMMIT_TIME,
                  },
                  targetIds: TARGET_IDS,
                },
              },
            ],
          },
        ],
      },
      commitExchange(
        'set-ord-live-2',
        [
          {
            update: {
              name: `${DOCUMENTS}/orders/ord-live-2`,
              fields: { status: { stringValue: 'live' }, total: { integerValue: '35' } },
            },
          },
        ],
        [{ updateTime: COMMIT_TIME }],
      ),
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
          { transaction: TRANSACTION },
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
            readTime: READ_TIME,
          },
        ],
      },
      commitExchange(
        'tx-commit-ord-1',
        [
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
        [{ updateTime: COMMIT_TIME }],
        { transaction: TRANSACTION },
      ),
      {
        kind: 'admin-firestore',
        id: 'query-orders-projected',
        rpc: 'RunQuery',
        request: {
          parent: DOCUMENTS,
          structuredQuery: {
            from: [{ collectionId: 'orders' }],
            select: { fields: [{ fieldPath: 'status' }] },
          },
        },
        responses: [
          {
            document: {
              name: `${DOCUMENTS}/orders/ord-1`,
              fields: { status: { stringValue: 'fulfilled' } },
              createTime: '2026-11-01T08:00:00.000001Z',
              updateTime: '2026-11-01T08:00:04.000001Z',
            },
            readTime: READ_TIME,
          },
        ],
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
          { transaction: TRANSACTION },
          {
            found: {
              name: `${DOCUMENTS}/orders/ord-2`,
              fields: { status: { stringValue: 'shipped' }, total: { integerValue: '80' } },
              createTime: '2026-11-01T08:00:01.000001Z',
              updateTime: '2026-11-01T08:00:01.000001Z',
            },
            readTime: READ_TIME,
          },
        ],
      },
      {
        kind: 'admin-firestore',
        id: 'tx-rollback-ord-2',
        rpc: 'Rollback',
        request: { database: DATABASE, transaction: TRANSACTION },
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
      rtdbExchange('rtdb-set-q1', 'p', { p: '/queues/q-1', d: { state: 'ready', workers: 2 } }),
      rtdbExchange('rtdb-update-q1', 'm', { p: '/queues/q-1', d: { region: 'us', workers: 3 } }),
      rtdbExchange('rtdb-set-with-priority', 'p', {
        p: '/queues/priority-q',
        d: { '.priority': 10, state: 'prio' },
      }),
      rtdbExchange('rtdb-set-temp-q', 'p', { p: '/queues/temp-q', d: { state: 'ephemeral' } }),
      rtdbExchange('rtdb-remove-temp-q', 'p', { p: '/queues/temp-q', d: null }),
      rtdbExchange('rtdb-push-item', 'p', {
        p: { $: 'pushId', name: 'pushedQueueItem', parent: '/queues/items' },
        d: { job: 'sync' },
      }),
      rtdbExchange('rtdb-get-extra', 'g', { p: '/queues/extra', q: {} }, { s: 'ok', d: { state: 'loaded' } }),
      rtdbExchange('rtdb-set-regions', 'p', {
        p: '/queues/by-region',
        d: { east: { region: 'east' }, west: { region: 'west' } },
      }),
      rtdbExchange(
        'rtdb-filtered-get',
        'g',
        {
          p: '/queues/by-region',
          q: { sp: 'west', sin: true, ep: 'west', ein: true, i: 'region' },
        },
        { s: 'ok', d: { west: { region: 'synced-west' } } },
      ),
      rtdbExchange(
        'rtdb-once-q',
        'q',
        { p: '/queues/once-q', h: { $: 'any' } },
        { s: 'ok', d: {} },
        { events: [{ t: 'd', d: { a: 'd', b: { p: '/queues/once-q', d: { state: 'once-read' } } } }] },
      ),
      rtdbExchange(
        'rtdb-on-watch-q',
        'q',
        { p: '/queues/watch-q', h: { $: 'any' } },
        { s: 'ok', d: {} },
        {
          events: [{ t: 'd', d: { a: 'd', b: { p: '/queues/watch-q', d: { step: 1 } } } }],
          later: [
            {
              after: 'rtdb-set-watch-q',
              events: [{ t: 'd', d: { a: 'd', b: { p: '/queues/watch-q', d: { step: 2 } } } }],
            },
          ],
        },
      ),
      rtdbExchange('rtdb-set-watch-q', 'p', { p: '/queues/watch-q', d: { step: 2 } }),
      rtdbExchange(
        'rtdb-listen-counter',
        'q',
        { p: '/counters/processed', h: { $: 'any' } },
        { s: 'ok', d: {} },
        { events: [{ t: 'd', d: { a: 'd', b: { p: '/counters/processed', d: 4 } } }] },
      ),
      rtdbExchange(
        'rtdb-tx-counter-stale',
        'p',
        { p: '/counters/processed', d: 1, h: '' },
        { s: 'datastale', d: 'Transaction hash does not match' },
      ),
      rtdbExchange('rtdb-tx-counter', 'p', { p: '/counters/processed', d: 5, h: { $: 'any' } }),
      rtdbExchange('rtdb-listen-aborted', 'q', { p: '/counters/aborted', h: { $: 'any' } }, { s: 'ok', d: {} }),
      {
        kind: 'listen',
        id: 'client-read-catalog',
        target: { documents: { documents: [`${DOCUMENTS}/catalog/cat-1`] } },
        batches: [
          {
            messages: [
              { targetChange: { targetChangeType: 'ADD', targetIds: TARGET_IDS } },
              {
                documentChange: {
                  document: {
                    name: `${DOCUMENTS}/catalog/cat-1`,
                    fields: { label: { stringValue: 'Widget' } },
                    createTime: '2026-11-01T08:05:00.000000Z',
                    updateTime: '2026-11-01T08:05:00.000000Z',
                  },
                  targetIds: TARGET_IDS,
                },
              },
              {
                targetChange: {
                  targetChangeType: 'CURRENT',
                  targetIds: TARGET_IDS,
                  resumeToken: RESUME_TOKEN,
                  readTime: READ_TIME,
                },
              },
              { targetChange: { targetChangeType: 'NO_CHANGE', resumeToken: RESUME_TOKEN, readTime: READ_TIME } },
            ],
          },
        ],
      },
    ],
  };
}
