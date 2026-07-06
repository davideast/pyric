/** #514: `simulate_firestore_write` resolves rules from the deployed
 *  ruleset (workspace store) when the `rules` arg is omitted, so the agent
 *  stops re-shipping the whole ruleset on every call. */
import { describe, test, expect, afterEach } from 'bun:test';
import { buildSimulateFirestoreWriteHandler } from './simulate-firestore-write';
import { useWorkspaceStore } from '~/lib/store/workspace';

const READ_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /pub/{id} { allow read: if true; allow write: if false; }
  }
}`;

const WRITE_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /pub/{id} { allow read, write: if true; }
  }
}`;

const handler = buildSimulateFirestoreWriteHandler();
afterEach(() => useWorkspaceStore.getState().setRules(''));

describe('simulate_firestore_write — rules fallback (#514)', () => {
  test('omitting rules → evaluates against the deployed (store) ruleset', async () => {
    useWorkspaceStore.getState().setRules(READ_ONLY);
    const read = await handler.execute({ method: 'get', path: 'pub/x', auth: null } as never, {} as never);
    expect(read.ok).toBe(true);
    expect(read.data!.decision).toBe('ALLOW');
    const write = await handler.execute({ method: 'create', path: 'pub/x', auth: null, data: { a: 1 } } as never, {} as never);
    expect(write.data!.decision).toBe('DENY'); // store ruleset denies writes
  });

  test('explicit rules arg overrides the deployed ruleset', async () => {
    useWorkspaceStore.getState().setRules(READ_ONLY); // store denies writes…
    const write = await handler.execute({
      rules: WRITE_OPEN, // …but the explicit hypothetical allows them
      method: 'create',
      path: 'pub/x',
      auth: null,
      data: { a: 1 },
    } as never, {} as never);
    expect(write.data!.decision).toBe('ALLOW');
  });

  test('no rules arg and nothing deployed → actionable ok:false', async () => {
    useWorkspaceStore.getState().setRules('');
    const res = await handler.execute({ method: 'get', path: 'pub/x', auth: null } as never, {} as never);
    expect(res.ok).toBe(false);
    expect(res.data!.summary).toContain('Write /workspace/firestore.rules first');
  });
});
