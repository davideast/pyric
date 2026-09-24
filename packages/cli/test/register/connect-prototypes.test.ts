/**
 * The built-in prototypes the network guard patches
 * (`src/register/connect-prototypes.ts`).
 */
import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import { nodeAgentPrototypes } from '../../src/register/connect-prototypes.js';

describe('nodeAgentPrototypes', () => {
  it('returns the http and https Agent prototypes, in that order', () => {
    expect(nodeAgentPrototypes()).toEqual([http.Agent.prototype, https.Agent.prototype]);
  });
});
