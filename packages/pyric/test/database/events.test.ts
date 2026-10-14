/** What the Realtime Database surface declares it puts on the sandbox event stream. */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { RTDB_EVENT_RECORD } from '../../src/database/events.js';
import {
  getAdminDatabase,
  getDatabase,
  onValue,
  ref,
  set,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

describe('rtdb event record', () => {
  it('declares the service name the stream attributes its events to', () => {
    expect(RTDB_EVENT_RECORD.service).toBe('rtdb');
  });

  it('enumerates every operation it emits', () => {
    expect([...RTDB_EVENT_RECORD.operations]).toEqual([
      'set',
      'update',
      'remove',
      'transaction',
      'setPriority',
    ]);
  });

  it('names what the event path addresses', () => {
    expect(RTDB_EVENT_RECORD.target.name).toBe('path');
  });
});

describe('rtdb events name the instance they hit', () => {
  const OPEN = { rules: { '.read': true, '.write': true } };

  const KINDS = new Set(['operation', 'commit', 'listener', 'service_mutation']);

  /** The operation, commit, listener and mutation events of one listener, one app write and one admin write. */
  async function eventsOf(url?: string): Promise<SandboxEvent[]> {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox, url);
    rtdbSandbox.setRules(db, OPEN);
    const unsubscribe = onValue(ref(db, 'rooms/r1'), () => {});
    await set(ref(db, 'rooms/r1'), { name: 'one' });
    await set(ref(getAdminDatabase(sandbox, url), 'rooms/r2'), { name: 'two' });
    unsubscribe();
    return sandbox.history().filter((event) =>
      KINDS.has(event.kind) && 'service' in event && event.service === 'rtdb');
  }

  it('stamps the instance name on the operation, commit, listener and mutation events of a named instance', async () => {
    const events = await eventsOf('https://shard-00.firebaseio.com');
    expect(new Set(events.map((event) => event.kind))).toEqual(KINDS);
    for (const event of events) expect(event).toMatchObject({ instance: 'shard-00' });
  });

  it('leaves the field off every event of the default instance', async () => {
    const events = await eventsOf();
    expect(new Set(events.map((event) => event.kind))).toEqual(KINDS);
    for (const event of events) expect(Object.hasOwn(event, 'instance')).toBe(false);
  });

  it('names the instance by its name when the URL selects it with ?ns=', async () => {
    const events = await eventsOf('http://localhost:9000/?ns=shard-01');
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ instance: 'shard-01' });
  });
});
