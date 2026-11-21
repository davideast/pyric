/**
 * Compile-time upstream parity and runtime exercises for `pyric/storage`
 * public TypeScript exports (`EmulatorMockTokenOptions`, `ListOptions`,
 * `StorageObserver`, `UploadMetadata`).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import type * as Firebase from 'firebase/storage';
import { initializeSandbox } from 'pyric/sandbox';
import {
  connectStorageEmulator,
  getStorageSandbox,
  ref,
  StorageError,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
  type EmulatorMockTokenOptions,
  type ListOptions,
  type StorageObserver,
  type TaskEvent,
  type TaskState,
  type UploadMetadata,
  type UploadTask,
  type UploadTaskSnapshot,
} from '../../src/storage/index.js';
import type * as StorageTypesModule from '../../src/storage/types.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type StorageObserverErrorFn = NonNullable<StorageObserver<UploadTaskSnapshot>['error']>;
type FirebaseObserverErrorFn = NonNullable<Firebase.StorageObserver<Firebase.UploadTaskSnapshot>['error']>;

type Parity = {
  EmulatorMockTokenOptions: Same<EmulatorMockTokenOptions, Firebase.EmulatorMockTokenOptions>;
  EmulatorMockTokenOptionsModule: Same<
    StorageTypesModule.EmulatorMockTokenOptions,
    Firebase.EmulatorMockTokenOptions
  >;
  ListOptions: Same<ListOptions, Firebase.ListOptions>;
  ListOptionsModule: Same<StorageTypesModule.ListOptions, Firebase.ListOptions>;
  UploadMetadata: Same<UploadMetadata, Firebase.UploadMetadata>;
  TaskEvent: Same<TaskEvent, Firebase.TaskEvent>;
  TaskState: Same<TaskState, Firebase.TaskState>;
  StorageObserverNextAndComplete: Same<
    Omit<StorageObserver<{ count: number }>, 'error'>,
    Omit<Firebase.StorageObserver<{ count: number }>, 'error'>
  >;
  StorageObserverErrorReturn: Same<
    ReturnType<StorageObserverErrorFn>,
    ReturnType<FirebaseObserverErrorFn>
  >;
  StorageObserverErrorParam: Same<Parameters<StorageObserverErrorFn>, [StorageError]>;
  StorageObserverErrorNullability: Same<
    null extends StorageObserver<string>['error'] ? true : false,
    null extends Firebase.StorageObserver<string>['error'] ? true : false
  >;
};

const parityChecks: { [K in keyof Parity]: true } = {
  EmulatorMockTokenOptions: true,
  EmulatorMockTokenOptionsModule: true,
  ListOptions: true,
  ListOptionsModule: true,
  UploadMetadata: true,
  TaskEvent: true,
  TaskState: true,
  StorageObserverNextAndComplete: true,
  StorageObserverErrorReturn: true,
  StorageObserverErrorParam: true,
  StorageObserverErrorNullability: true,
};

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-storage-types-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('pyric/storage public TypeScript type parity', () => {
  it('typechecks bidirectional parity against firebase/storage with zero diagnostics', () => {
    expect(parityChecks.EmulatorMockTokenOptions).toBe(true);
    const program = ts.createProgram([import.meta.path], {
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  }, 30_000);

  it('accepts EmulatorMockTokenOptions, UploadMetadata, ListOptions, and StorageObserver in consumer calls', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('consumer-types'),
      rules: OPEN_RULES,
    });

    const mockToken: EmulatorMockTokenOptions = {
      sub: 'user-alpha',
      email: 'alpha@example.com',
      email_verified: true,
    };
    connectStorageEmulator(storage, '127.0.0.1', 9199, { mockUserToken: mockToken });

    const pageOptions: ListOptions = { maxResults: 25, pageToken: null };
    expect(pageOptions.maxResults).toBe(25);

    const uploadMeta: UploadMetadata = {
      contentType: 'text/plain',
      customMetadata: { scope: 'unit' },
      md5Hash: undefined,
    };
    const itemRef = ref(storage, 'items/first.txt');
    const uploaded = await uploadBytes(itemRef, new TextEncoder().encode('alpha'), uploadMeta);
    expect(uploaded.metadata.contentType).toBe('text/plain');

    const stringRef = ref(storage, 'items/second.txt');
    const stringUploaded = await uploadString(stringRef, 'beta', 'raw', uploadMeta);
    expect(stringUploaded.metadata.customMetadata).toEqual({ scope: 'unit' });

    const states: TaskState[] = [];
    let completed = false;
    const observer: StorageObserver<UploadTaskSnapshot> = {
      next: (snapshot) => {
        states.push(snapshot.state);
      },
      error: (err) => {
        throw err;
      },
      complete: () => {
        completed = true;
      },
    };

    const resumableRef = ref(storage, 'items/third.txt');
    const task: UploadTask = uploadBytesResumable(
      resumableRef,
      new TextEncoder().encode('gamma'),
      uploadMeta,
    );
    const eventName: TaskEvent = 'state_changed';
    task.on(eventName, observer);
    const finalSnapshot = await task;
    expect(finalSnapshot.state).toBe('success');
    expect(completed).toBe(true);
    expect(states.includes('running')).toBe(true);
    expect(states.includes('success')).toBe(false);
  });
});
