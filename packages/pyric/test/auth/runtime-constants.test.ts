import { expect, test } from 'bun:test';
import * as firebase from 'firebase/auth';
import * as mirror from '../../src/auth/index.js';

for (const name of ["FactorId"] as const) {
  test(`auth ${name} has the installed Firebase runtime values`, () => {
    expect(Reflect.get(mirror, name)).toEqual(firebase[name]);
  });
}
