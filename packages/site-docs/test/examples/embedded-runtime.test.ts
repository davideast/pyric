import { describe, expect, it } from 'bun:test';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import { createEmbeddedExampleRuntime } from '../../src/examples/embedded-runtime';
import { definePyricExample } from '../../src/examples/definition';

const statefulDefinition = definePyricExample({
  header: 'State isolation test',
  subLabel: 'Test fixture',
  summary: 'Increment a document so reset behavior is observable.',
  docsPath: '/test/',
  service: 'firestore',
  firestore: {
    rules: `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /examples/{exampleId} {
      allow read, write: if request.auth.uid == resource.data.ownerId
        || request.auth.uid == request.resource.data.ownerId;
    }
  }
}`,
  },
  async run({ sandbox }) {
    const counter = doc(
      getFirestore(sandbox.withAuth({ uid: 'ada' })),
      'examples',
      'counter',
    );
    const previous = snapshotDocuments(sandbox)['examples/counter'];
    const count = Number(previous?.count ?? 0) + 1;
    await setDoc(counter, { count, ownerId: 'ada' });
    return count;
  },
});

describe('embedded example runtime', () => {
  it('runs against a fresh sandbox and resets to another fresh sandbox', async () => {
    const first = createEmbeddedExampleRuntime(statefulDefinition);

    expect(await first.run()).toBe(1);
    expect(await first.run()).toBe(2);
    expect(await first.reset().run()).toBe(1);
  });
});
