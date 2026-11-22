/**
 * Pure Firebase project selection (`selectFirebaseProject`) shared across
 * every Pyric plane (#1454).
 */
import { describe, expect, test } from 'bun:test';
import {
  describeFirebaseProject,
  parseFirebaseToolsActiveProjects,
  parsePyricConfigProject,
  selectFirebaseProject,
} from '../../../src/sandbox/internal/firebase-project.js';

const RC = {
  projects: {
    default: 'rc-default',
    staging: 'staging-proj',
    prod: 'prod-proj',
  },
};

describe('selectFirebaseProject', () => {
  test('precedence: option > PYRIC_PROJECT > pyric.json > firebase use > .firebaserc', () => {
    expect(
      selectFirebaseProject({
        option: 'staging',
        envProject: 'prod',
        configProject: 'rc-default',
        readRc: () => RC,
        readActiveLookup: () => ({
          activeProjects: { '/app': 'prod' },
          ancestorChains: [['/app', '/']],
        }),
      }),
    ).toEqual({ projectId: 'staging-proj', source: 'option', alias: 'staging' });

    expect(
      selectFirebaseProject({
        envProject: 'prod',
        configProject: 'rc-default',
        readRc: () => RC,
      }),
    ).toEqual({ projectId: 'prod-proj', source: 'PYRIC_PROJECT', alias: 'prod' });

    expect(
      selectFirebaseProject({
        readConfigProject: () => 'staging',
        readRc: () => RC,
      }),
    ).toEqual({ projectId: 'staging-proj', source: 'pyric-config', alias: 'staging' });

    expect(
      selectFirebaseProject({
        readRc: () => RC,
        readActiveLookup: () => ({
          activeProjects: { '/workspace': 'prod' },
          ancestorChains: [['/workspace/web', '/workspace', '/']],
        }),
      }),
    ).toEqual({ projectId: 'prod-proj', source: 'firebase-use', alias: 'prod' });

    expect(selectFirebaseProject({ readRc: () => RC })).toEqual({
      projectId: 'rc-default',
      source: 'firebaserc',
      alias: 'default',
    });
  });

  test('selects the sole .firebaserc alias when there is no default alias', () => {
    expect(
      selectFirebaseProject({
        readRc: () => ({ projects: { staging: 'staging-only' } }),
      }),
    ).toEqual({ projectId: 'staging-only', source: 'firebaserc', alias: 'staging' });
  });

  test('parses pyric.json and firebase-tools configstore payloads safely', () => {
    expect(parsePyricConfigProject('{"project":"staging"}')).toBe('staging');
    expect(parsePyricConfigProject('{"project":""}')).toBeUndefined();
    expect(parsePyricConfigProject('{bad')).toBeUndefined();

    expect(parseFirebaseToolsActiveProjects('{"activeProjects":{"/p":"staging"}}')).toEqual({
      '/p': 'staging',
    });
    expect(parseFirebaseToolsActiveProjects('{bad')).toBeNull();
    expect(
      describeFirebaseProject({ projectId: 'staging-proj', source: 'PYRIC_PROJECT', alias: 'staging' }),
    ).toBe('"staging-proj" (from PYRIC_PROJECT alias "staging")');
  });
});
