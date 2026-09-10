/**
 * The `read` half of effect enforcement: a method the record calls `read`
 * changes nothing.
 *
 * The other two effect checks refuse a call. This one cannot, because a read
 * that quietly wrote would return a perfectly good result; the only way to
 * catch it is to hash the sandbox on both sides of the call. Every read is
 * exercised with its own declared example, so a record that ships an example
 * it cannot run is caught here too, and the hash covers every service the
 * sandbox holds rather than Firestore alone.
 *
 * A read whose subject is absent never reaches the state it would have
 * touched, so a comparison over that call proves nothing. Each read therefore
 * runs against a sandbox that holds what its example names, and the call has
 * to succeed before the two hashes are compared.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFullState, initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import { methodByName, METHODS, toolByName } from '../../../src/bridge/surface/methods/registry.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/types.js';
import {
  ALICE_ACTOR,
  OPEN_ORDER_TARGET,
  OWNER_ONLY_INVARIANT,
  OWNER_WRITE_OBSERVATION,
  PAYLOAD_MUTATION,
  recordNoteSession,
  writeCapture,
} from './assurance-fixture.js';
import { OPEN_ORDER_RULES } from '../../fixtures/order-rules.js';

const surface = renderSurface('sdk-service');

/** Call one method of the surface, by the key its record is named after. */
type Call = (key: string, args: Record<string, unknown>) => Promise<OperationResult>;

/** One hash over everything the sandbox holds, across every service. */
async function stateHash(sandbox: Parameters<typeof captureFullState>[0]): Promise<string> {
  const state = await captureFullState(sandbox);
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

/** A caller bound to one sandbox context, which throws rather than returning a refusal. */
function callWith(ctx: SurfaceContext): Call {
  return async (key, args) => {
    const [toolName, methodName] = key.split('.');
    const tool = surface.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`no rendered tool named '${String(toolName)}'`);
    return tool.execute({ method: methodName, args }, ctx);
  };
}

/** The example another record declares, which is the shape this one reads back. */
function exampleOf(key: string): Record<string, unknown> {
  const [toolName, methodName] = key.split('.');
  const tool = toolByName(String(toolName));
  if (tool === undefined) throw new Error(`no tool named '${String(toolName)}'`);
  const method = methodByName(tool, String(methodName));
  if (method === undefined) throw new Error(`no method named '${key}'`);
  return method.example;
}

/** Undo one precondition once the read has been judged. */
type Teardown = () => Promise<void>;

/** The teardown of a precondition whose state dies with its sandbox. */
const NOTHING_TO_UNDO: Teardown = async () => undefined;

/** Run one setup call and fail loudly when the setup itself did not take. */
async function must(call: Call, key: string, args: Record<string, unknown>): Promise<void> {
  const result = await call(key, args);
  if (!result.ok) throw new Error(`setting up ${key} failed: ${result.summary}`);
}

/**
 * Upload the object `storage.getBytes` and `storage.getMetadata` name.
 *
 * The bucket outlives the sandbox that wrote to it, so this is the one
 * precondition that has to put the object back the way it found it. A
 * neighbouring suite counts what a bucket holds.
 */
async function uploadTheExampleObject(call: Call): Promise<Teardown> {
  const uploaded = exampleOf('storage.uploadBytes');
  await must(call, 'storage.uploadBytes', uploaded);
  return async () => {
    await must(call, 'storage.deleteObject', { path: uploaded.path });
  };
}

/** Create the account `auth.getUser` names. */
async function createTheExampleUser(call: Call): Promise<Teardown> {
  await must(call, 'auth.createUser', { uid: String(exampleOf('auth.getUser').uid) });
  return NOTHING_TO_UNDO;
}

/** Create the account `auth.getUserByEmail` names, by the address it looks up. */
async function createTheExampleAddress(call: Call): Promise<Teardown> {
  await must(call, 'auth.createUser', {
    uid: 'alice',
    email: String(exampleOf('auth.getUserByEmail').email),
  });
  return NOTHING_TO_UNDO;
}

/** Fork the branch `sandbox.diff` names. */
async function forkTheExampleBranch(call: Call): Promise<Teardown> {
  await must(call, 'sandbox.fork', exampleOf('sandbox.fork'));
  return NOTHING_TO_UNDO;
}

/**
 * Drive a campaign to a completed probe under the ids `assurance.inspect`
 * names. The probe carries its id explicitly, because a minted id names the
 * observation it came from and the example names a probe, not an observation.
 */
async function runTheExampleCampaign(call: Call): Promise<Teardown> {
  const example = exampleOf('assurance.inspect');
  const campaignId = String(example.campaignId);
  await must(call, 'assurance.start', { campaignId, target: OPEN_ORDER_TARGET });
  await must(call, 'assurance.map', {
    campaignId,
    actors: [ALICE_ACTOR],
    observations: [OWNER_WRITE_OBSERVATION],
  });
  await must(call, 'assurance.define', { campaignId, invariants: [OWNER_ONLY_INVARIANT] });
  await must(call, 'assurance.propose', {
    campaignId,
    observationId: OWNER_WRITE_OBSERVATION.id,
    invariantId: OWNER_ONLY_INVARIANT.id,
    mutations: [{ ...PAYLOAD_MUTATION, id: String(example.probeId) }],
  });
  await must(call, 'assurance.run', { campaignId });
  return NOTHING_TO_UNDO;
}

/**
 * What each read method's example needs before the call can reach the state it
 * reads. A read absent from this table needs nothing beyond the fresh sandbox,
 * its rules, and the planted capture.
 */
const PRECONDITIONS: Record<string, (call: Call) => Promise<Teardown>> = {
  'storage.getBytes': uploadTheExampleObject,
  'storage.getMetadata': uploadTheExampleObject,
  'auth.getUser': createTheExampleUser,
  'auth.getUserByEmail': createTheExampleAddress,
  'sandbox.diff': forkTheExampleBranch,
  'assurance.inspect': runTheExampleCampaign,
};

describe('a read changes nothing', () => {
  for (const method of METHODS) {
    if (method.effect !== 'read') continue;
    it(`${method.key} leaves the sandbox exactly as it found it`, async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, OPEN_ORDER_RULES);
      const projectDir = mkdtempSync(join(tmpdir(), 'pyric-read-effect-'));
      // A capture where the methods that read one look for it, so a read that
      // names a session has something real to read rather than failing early.
      writeCapture(projectDir, '.pyric/last-session.json', await recordNoteSession());
      const ctx = createSurfaceContext(sandbox, projectDir);
      const call = callWith(ctx);
      const precondition = PRECONDITIONS[method.key];
      const undo = precondition === undefined ? NOTHING_TO_UNDO : await precondition(call);

      const before = await stateHash(sandbox);
      const result = await call(method.key, method.example);
      const after = await stateHash(sandbox);
      await undo();
      // A read that could not run read nothing, so the hashes would agree for
      // the wrong reason. The example is part of the record, and a record whose
      // example does not run is the defect this catches.
      expect(result.ok).toBe(true);
      expect(after).toBe(before);
    });
  }
});
