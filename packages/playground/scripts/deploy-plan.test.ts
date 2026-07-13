import { describe, expect, test } from 'bun:test';
import { createDeployPlan, functionEndpointUrl } from './deploy-plan';

describe('Playground Firebase shipping plan', () => {
  test('deploys the function before Hosting through firebase-tools', () => {
    expect(createDeployPlan('digame-mas')).toEqual([
      {
        kind: 'deploy',
        args: [
          'deploy',
          '--config',
          'firebase.json',
          '--project',
          'digame-mas',
          '--only',
          'functions:inferenceApi',
          '--non-interactive',
        ],
      },
      {
        kind: 'discover-endpoint',
        args: [
          'functions:list',
          '--config',
          'firebase.json',
          '--project',
          'digame-mas',
          '--json',
          '--non-interactive',
        ],
      },
      {
        kind: 'deploy',
        args: [
          'deploy',
          '--config',
          'firebase.json',
          '--project',
          'digame-mas',
          '--only',
          'hosting',
          '--non-interactive',
        ],
      },
    ]);
  });

  test('reads the direct function endpoint from firebase-tools output', () => {
    expect(functionEndpointUrl({
      status: 'success',
      result: [
        {
          id: 'inferenceApi',
          region: 'us-central1',
          uri: 'https://us-central1-digame-mas.cloudfunctions.net/inferenceApi',
        },
      ],
    })).toBe(
      'https://us-central1-digame-mas.cloudfunctions.net/inferenceApi',
    );
  });

  test('fails closed when firebase-tools does not return the inference endpoint', () => {
    expect(() => functionEndpointUrl({ status: 'success', result: [] })).toThrow(
      'inferenceApi',
    );
  });
});
