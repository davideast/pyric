import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  onValue,
  ref,
  set,
  setPriority,
  setWithPriority,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

const priorityObservation = (JSON.parse(readFileSync(join(
  import.meta.dir,
  '..', '..', '..', '..', '..',
  'packages', 'conformance', 'observations', 'rtdb-modular',
  'rtdb-modular-priority-contract.json',
), 'utf8')) as { behavior: Record<string, unknown> }).behavior;

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  rtdbSandbox.setDefaultPolicy(db, 'allow');
  return db;
}

describe('priority metadata value-listener fanout', () => {
  it('notifies a descendant when an ancestor replacement clears its priority', async () => {
    const db = setup();
    const child = ref(db, 'parent/child');
    await setWithPriority(child, 1, 9);

    const deliveries: Array<{ value: unknown; priority: unknown }> = [];
    onValue(child, (snapshot) => deliveries.push({
      value: snapshot.val(),
      priority: snapshot.priority,
    }));

    await set(ref(db, 'parent'), { child: 1 });
    const afterAncestorReplacementCount = deliveries.length;
    await setPriority(ref(db, 'parent'), 4);
    const afterAncestorPriorityOnlyCount = deliveries.length;
    await set(child, 2);

    expect({
      descendantPriorityDeliveries: deliveries,
      afterAncestorReplacementCount,
      afterAncestorPriorityOnlyCount,
    }).toEqual({
      descendantPriorityDeliveries: priorityObservation.descendantPriorityDeliveries,
      afterAncestorReplacementCount: priorityObservation.afterAncestorReplacementCount,
      afterAncestorPriorityOnlyCount: priorityObservation.afterAncestorPriorityOnlyCount,
    });
  });

  it('does not notify a descendant when only its ancestor priority changes', async () => {
    const db = setup();
    const parent = ref(db, 'parent');
    const child = ref(db, 'parent/child');
    await set(parent, { child: 1 });

    let deliveries = 0;
    onValue(child, () => { deliveries++; });

    await setPriority(parent, 9);

    expect(deliveries).toBe(1);
  });
});
