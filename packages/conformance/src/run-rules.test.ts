import { describe, expect, it } from 'bun:test';
import { selectFirestoreScenarios } from './run-rules.ts';

describe('run-rules Firestore scenario selection', () => {
  it('selects exactly one scenario by id', () => {
    expect(
      selectFirestoreScenarios([
        '--scenario',
        'resource-document-identity',
      ]).map((scenario) => scenario.id),
    ).toEqual(['resource-document-identity']);
  });

  it('rejects a selector with no scenario id', () => {
    expect(() => selectFirestoreScenarios(['--scenario'])).toThrow(
      /requires an id/,
    );
  });

  it('rejects an unknown scenario id', () => {
    expect(() =>
      selectFirestoreScenarios(['--scenario', 'not-a-scenario']),
    ).toThrow(/unknown Firestore scenario/);
  });

  it('rejects duplicate scenario selectors', () => {
    expect(() =>
      selectFirestoreScenarios([
        '--scenario',
        'resource-document-identity',
        '--scenario',
        'required-fields-and-mapdiff',
      ]),
    ).toThrow(/only one --scenario/);
  });
});
