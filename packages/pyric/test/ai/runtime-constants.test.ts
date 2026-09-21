import { expect, test } from 'bun:test';
import * as firebase from 'firebase/ai';
import * as mirror from '../../src/ai/index.js';

for (const name of ["ImagenAspectRatio", "ImagenPersonFilterLevel", "ImagenSafetyFilterLevel", "InferenceMode", "InferenceSource", "LiveResponseType"] as const) {
  test(`ai ${name} has the installed Firebase runtime values`, () => {
    expect(Reflect.get(mirror, name)).toEqual(firebase[name]);
  });
}
