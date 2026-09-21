import { expect, test } from 'bun:test';
import * as firebase from 'firebase/storage';
import * as storage from '../../src/storage/index.js';

for (const name of ['StringFormat', 'StorageErrorCode'] as const) {
  test(`Storage ${name} has the installed Firebase runtime values`, () => {
    expect(Reflect.get(storage, name)).toEqual(firebase[name]);
  });
}
