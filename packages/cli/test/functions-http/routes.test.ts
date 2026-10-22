import { describe, expect, test } from 'bun:test';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import { matchEmulatorPath, unknownFunctionMessage } from '../../src/functions/http/routes.js';

const fn = (exportName: string, regions = ['us-central1']): HttpFunctionInfo => ({
  exportName,
  regions,
  platform: 'gcfv2',
  privateInvoker: false,
  timeoutSeconds: null,
});

const table = { projectId: 'demo-app', functions: [fn('api'), fn('east', ['us-east1'])] };

describe('matchEmulatorPath', () => {
  test('forwards / plus what follows the name, with the query, without decoding', () => {
    const forward = (url: string) => {
      const route = matchEmulatorPath(url, table);
      return route?.kind === 'function' ? route.forwardUrl : route?.kind;
    };
    expect(forward('/demo-app/us-central1/api')).toBe('/');
    expect(forward('/demo-app/us-central1/api?x=1')).toBe('/?x=1');
    expect(forward('/demo-app/us-central1/api/')).toBe('/');
    expect(forward('/demo-app/us-central1/api/a/b/?x=1')).toBe('/a/b/?x=1');
    expect(forward('/demo-app/us-central1/api/%E2%9C%93')).toBe('/%E2%9C%93');
    expect(forward('/demo-app/us-east1/east/here')).toBe('/here');
  });

  test('a function answers only under the regions it deploys to', () => {
    expect(matchEmulatorPath('/demo-app/us-east1/api', table)).toEqual({ kind: 'unknown-function', key: 'us-east1-api' });
    expect(matchEmulatorPath('/demo-app/us-central1/east', table)).toEqual({ kind: 'unknown-function', key: 'us-central1-east' });
  });

  test('paths that are not the emulator shape under this project are left to the plane', () => {
    expect(matchEmulatorPath('/other-project/us-central1/api', table)).toBeNull();
    expect(matchEmulatorPath('/demo-app/assets/logo.png', table)).toBeNull();
    expect(matchEmulatorPath('/demo-app/us-central1', table)).toBeNull();
    expect(matchEmulatorPath('/index.html', table)).toBeNull();
  });

  test('before the function list is known, the shape alone matches', () => {
    expect(matchEmulatorPath('/demo-app/us-central1/api', { projectId: 'demo-app', functions: null })).toEqual({ kind: 'emulator-path' });
  });

  test('the unknown-function answer lists every served key', () => {
    expect(unknownFunctionMessage('us-central1-nope', table.functions)).toBe(
      'Function us-central1-nope does not exist, valid functions are: us-central1-api, us-east1-east',
    );
  });
});
