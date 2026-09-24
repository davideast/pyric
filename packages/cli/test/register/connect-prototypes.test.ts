/**
 * The built-in prototypes the network guard patches
 * (`src/register/connect-prototypes.ts`).
 */
import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { nodeAgentPrototypes, nodeSocketPrototypes } from '../../src/register/connect-prototypes.js';

describe('nodeAgentPrototypes', () => {
  it('returns the http and https Agent prototypes, in that order', () => {
    expect(nodeAgentPrototypes()).toEqual([http.Agent.prototype, https.Agent.prototype]);
  });
});

describe('nodeSocketPrototypes', () => {
  it('returns the net.Socket prototype', () => {
    expect(nodeSocketPrototypes()).toEqual([net.Socket.prototype]);
  });
});
