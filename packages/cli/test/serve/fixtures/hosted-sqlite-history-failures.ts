import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { openNodeSqlite } from '../../../src/serve/hosted/persistence/sqlite.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';
const directory = process.argv[2];
let database = await openHostedDatabase(join(directory, 'source'));
await database.records.putRecords('hosted', new Map([
  ['meta', { version: 3, savedAt: 0, services: {} }], ['00', { docs: { 'notes/one': { value: 1 } } }],
]));
const committed = database.history.status().durableSequence;
database.history.observe({ kind: 'operation', id: 'pending', at: 1, service: 'auth' });
database.history.engine.append({ id: 1, timestamp: new Date().toISOString(), type: 'single', method: 'set',
  path: 'notes/one', allowed: true, auth: null, debugMessages: [],
  priorDocs: { 'notes/one': { value: 1 } }, nextDocs: { 'notes/one': { value: 2 } } }, false);
database.connection.exec("CREATE TRIGGER fail_history BEFORE INSERT ON history_records BEGIN SELECT RAISE(ABORT, 'injected'); END");
await assert.rejects(database.records.putRecords('hosted', new Map([['00', { docs: { 'notes/one': { value: 2 } } }]])));
assert.equal(database.history.status().healthy, false);
assert.equal(database.history.status().unrecorded, 2);
assert.equal(database.history.status().durableSequence, committed);
assert.deepEqual(database.readRecord('hosted', '00'), { docs: { 'notes/one': { value: 1 } } });
database.history.engine.append({ id: 2, timestamp: new Date().toISOString(), type: 'single', method: 'get',
  path: 'notes/one', allowed: true, auth: null, debugMessages: [] }, false);
assert.equal(database.history.status().pendingEvents, 0);
assert.equal(database.history.status().unrecorded, 3);
database.close();
const oversized = await openHostedDatabase(join(directory, 'oversized'));
oversized.connection.exec("CREATE TRIGGER fail_history BEFORE INSERT ON history_records BEGIN SELECT RAISE(ABORT, 'injected'); END");
assert.throws(() => oversized.history.observe({ kind: 'operation', id: 'oversized', at: 1, service: 'ai', text: 'x'.repeat(5 * 1024 * 1024) }));
assert.equal(oversized.history.status().unrecorded, 1);
oversized.close();
const raw = await openNodeSqlite(join(directory, 'source/state.sqlite'));
raw.exec('DROP TRIGGER fail_history');
raw.prepare("UPDATE history_records SET payload='{}' WHERE sequence=1").run();
raw.close();
// Startup checks index integrity; old payload validation happens only on access.
database = await openHostedDatabase(join(directory, 'source'));
assert.equal(database.history.engine.status().undoCount, 0);
assert.throws(() => database.history.list(), /record 1 is unreadable/);
assert.deepEqual(database.readRecord('hosted', '00'), { docs: { 'notes/one': { value: 1 } } });
database.close();
const report = await salvageHostedState(join(directory, 'source'), join(directory, 'repaired'));
assert.equal(report.excluded.some(item => item.namespace === 'history' && item.id === '1'), true);
const repaired = await openHostedDatabase(join(directory, 'repaired'));
assert.equal(repaired.history.list().records[0].kind, 'boundary');
assert.equal(repaired.history.engine.status().undoCount, 0);
repaired.close();
// Salvage must not rebuild an undo index pointing at an excluded journal record.
const damagedUndo = join(directory, 'damaged-undo');
const undoSource = await openHostedDatabase(damagedUndo);
undoSource.history.engine.append({ id: 1, timestamp: new Date().toISOString(), type: 'single', method: 'set',
  path: 'notes/one', allowed: true, auth: null, debugMessages: [],
  priorDocs: { 'notes/one': null }, nextDocs: { 'notes/one': { value: 1 } } }, false);
await undoSource.records.putRecords('hosted', new Map([
  ['meta', { version: 3, savedAt: 0, services: {} }], ['00', { docs: { 'notes/one': { value: 1 } } }],
]));
undoSource.close();
const damaged = await openNodeSqlite(join(damagedUndo, 'state.sqlite'));
damaged.exec("UPDATE history_records SET kind='boundary' WHERE sequence IN (SELECT record_sequence FROM history_undo)");
damaged.exec("UPDATE history_meta SET store_id='lost-identity' WHERE id=1");
damaged.close();
const undoReport = await salvageHostedState(damagedUndo, join(directory, 'repaired-undo'));
assert.ok(undoReport.excluded.some(item => item.namespace === 'history-identity'));
assert.ok(undoReport.excluded.some(item => item.namespace === 'undo'));
const undoRepaired = await openHostedDatabase(join(directory, 'repaired-undo'));
assert.equal(undoRepaired.history.engine.status().undoCount, 0);
assert.ok(undoRepaired.history.list().records.some(record => record.payload?.reason === 'salvage-exclusion'));
undoRepaired.close();
// Migrate only schema-1 stores; existing state survives, unavailable past is explicit.
const migration = join(directory, 'migration');
const initial = await openHostedDatabase(migration);
initial.close();
const old = await openNodeSqlite(join(migration, 'state.sqlite'));
old.exec('DROP TABLE history_records; DROP TABLE history_meta; DROP TABLE history_undo; DROP TABLE history_undo_state; PRAGMA user_version=1');
old.prepare('INSERT INTO records VALUES(?,?,?)').run('hosted', 'meta', '{"version":3,"savedAt":0,"services":{}}');
old.close();
const migrated = await openHostedDatabase(migration);
assert.deepEqual(migrated.readRecord('hosted', 'meta'), { version: 3, savedAt: 0, services: {} });
assert.deepEqual(migrated.history.list().records[0].payload, { reason: 'history-start', priorHistoryUnavailable: true });
migrated.close();
const malformed = await openNodeSqlite(join(migration, 'state.sqlite'));
malformed.exec("UPDATE history_meta SET store_id='invalid' WHERE id=1");
malformed.close();
await assert.rejects(openHostedDatabase(migration), /uuid/);
console.log('History failures passed');
