/**
 * Every service that declares an event record puts its state changes on the
 * one sandbox event stream, and puts nothing there for a read.
 *
 * The test drives each service through its own public seam, so it fails when a
 * service declares a record and never emits, when a service emits an operation
 * its record does not declare, and when a service joins the stream's
 * vocabulary with no case here to exercise it.
 *
 * Two things this asserts more narrowly than "one event, no event", because
 * more would be false:
 *
 *   - It counts `service_mutation` events for the service under test. A read
 *     against a rules-backed service legitimately puts a rules-evaluation
 *     `operation` event on the stream; what a read must never do is report a
 *     mutation.
 *   - It compares the captured sandbox state only for the services the
 *     sandbox captures state for. Messaging and AI hold no state a capture
 *     reaches, so there is no hash to move.
 *
 * `functions` is the one declared service whose seam is not in this package:
 * its trigger runtime lives in `@pyric/cli`, which depends downward on pyric.
 * `packages/cli/test/functions-rtdb/events.test.ts` and
 * `packages/cli/test/bridge/surface/handlers-functions.test.ts` exercise it,
 * and the partition below is what fails if a new service arrives with neither
 * a case here nor a place on that list.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import {
  MUTATION_EVENT_SERVICES,
  SERVICE_EVENT_RECORDS,
  captureFullState,
  initializeSandbox,
  type LocalSandbox,
  type MutationEventService,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getStorageSandbox, ref as storageRef, uploadBytes, getMetadata } from 'pyric/storage';
import { getDatabase, ref as dbRef, set, get, sandbox as rtdbSandbox } from 'pyric/database';
import { getMessaging, getToken } from 'pyric/messaging';
import { getAI, getGenerativeModel } from 'pyric/ai';
import { script, aiStatus } from 'pyric/ai/scripting';

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

/** One service's public seam: the change it makes, and the read beside it. */
interface ServiceCase {
  /** The operation the change is expected to report. */
  operation: string;
  /** Whether the sandbox captures state this change moves. */
  capturesState: boolean;
  /** Open the service and grant the change the rules it needs. */
  setup(sandbox: LocalSandbox): void;
  change(sandbox: LocalSandbox): Promise<void>;
  read(sandbox: LocalSandbox): Promise<void>;
}

/** The mutation events one service put on the stream. */
function mutationsFor(sandbox: LocalSandbox, service: MutationEventService): SandboxEvent[] {
  return sandbox
    .history()
    .filter((event) => event.kind === 'service_mutation' && event.service === service);
}

const CASES: Record<Exclude<MutationEventService, 'functions'>, ServiceCase> = {
  auth: {
    operation: 'user_create',
    capturesState: true,
    setup(sandbox) {
      getAuth(sandbox);
    },
    async change(sandbox) {
      authSandbox.createUser(getAuth(sandbox), { uid: 'alice', email: 'alice@example.com' });
    },
    async read(sandbox) {
      authSandbox.listUsers(getAuth(sandbox));
    },
  },
  storage: {
    operation: 'object_put',
    capturesState: true,
    setup(sandbox) {
      getStorageSandbox(sandbox, { rules: STORAGE_RULES });
    },
    async change(sandbox) {
      await uploadBytes(storageRef(getStorageSandbox(sandbox), 'notes/one.txt'), new Uint8Array([1, 2, 3]));
    },
    async read(sandbox) {
      await getMetadata(storageRef(getStorageSandbox(sandbox), 'notes/one.txt'));
    },
  },
  rtdb: {
    operation: 'set',
    capturesState: true,
    setup(sandbox) {
      rtdbSandbox.setDefaultPolicy(getDatabase(sandbox), 'allow');
    },
    async change(sandbox) {
      await set(dbRef(getDatabase(sandbox), 'rooms/r1/topic'), 'hello');
    },
    async read(sandbox) {
      await get(dbRef(getDatabase(sandbox), 'rooms/r1/topic'));
    },
  },
  messaging: {
    operation: 'token_minted',
    capturesState: false,
    setup(sandbox) {
      getMessaging(sandbox);
    },
    async change(sandbox) {
      await getToken(getMessaging(sandbox));
    },
    // A registration's token is minted once and stable after: a second call
    // reads the token the first minted, and mints nothing.
    async read(sandbox) {
      await getToken(getMessaging(sandbox));
    },
  },
  ai: {
    operation: 'generate_content',
    capturesState: false,
    setup(sandbox) {
      getAI(sandbox);
    },
    async change(sandbox) {
      const ai = getAI(sandbox);
      script(ai, [{ respond: { text: 'hi' } }]);
      await getGenerativeModel(ai, { model: 'gemini-2.5-flash' }).generateContent('hello');
    },
    async read(sandbox) {
      aiStatus(getAI(sandbox));
    },
  },
};

describe('event stream completeness', () => {
  it('has a case for every declared service, or names where the case lives', () => {
    const covered = [...Object.keys(CASES), 'functions'].sort();
    expect(covered).toEqual([...MUTATION_EVENT_SERVICES].sort());
  });

  for (const [name, serviceCase] of Object.entries(CASES)) {
    const service = name as MutationEventService;

    it(`reports one ${service} ${serviceCase.operation} for one state change`, async () => {
      const sandbox = initializeSandbox();
      serviceCase.setup(sandbox);
      const before = await captureFullState(sandbox);

      await serviceCase.change(sandbox);

      const emitted = mutationsFor(sandbox, service) as Array<SandboxEvent & { op: string }>;
      const matching = emitted.filter((event) => event.op === serviceCase.operation);
      expect(matching.length).toBe(1);
      expect([...SERVICE_EVENT_RECORDS[service].operations]).toContain(serviceCase.operation);
      for (const event of emitted) {
        expect([...SERVICE_EVENT_RECORDS[service].operations]).toContain(event.op);
      }

      if (serviceCase.capturesState) {
        const after = await captureFullState(sandbox);
        expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
      }
    });

    it(`reports no ${service} mutation and moves no state for a read`, async () => {
      const sandbox = initializeSandbox();
      serviceCase.setup(sandbox);
      await serviceCase.change(sandbox);
      const beforeCount = mutationsFor(sandbox, service).length;
      const beforeState = await captureFullState(sandbox);

      await serviceCase.read(sandbox);

      expect(mutationsFor(sandbox, service).length).toBe(beforeCount);
      const afterState = await captureFullState(sandbox);
      expect(JSON.stringify(afterState)).toBe(JSON.stringify(beforeState));
    });
  }
});
