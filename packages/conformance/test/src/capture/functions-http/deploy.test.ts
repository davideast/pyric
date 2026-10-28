import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIREBASE_TOOLS_VERSION,
  clearCaptureState,
  deployOutcome,
  inactiveFunctions,
  readCaptureState,
  resolveFirebaseTools,
  writeCaptureState,
} from '../../../../src/capture/functions-http/deploy.ts';

// firebase-tools 15.23.0 `lib/deploy/functions/prompts.js:179-189`, printed by
// `logError` as `Error: <message>` after `release/index.js:149` throws it.
const CLEANUP_POLICY_ERROR =
  "Error: Functions successfully deployed but could not set up cleanup policy in location us-east1. " +
  "Pass the --force option to automatically set up a cleanup policy or run 'firebase functions:artifacts:setpolicy' to manually set up a cleanup policy.";

describe('deployOutcome', () => {
  it('reads exit 0 as deployed', () => {
    expect(deployOutcome(0, '✔  Deploy complete!')).toBe('deployed');
  });

  it('reads the non-interactive cleanup policy refusal as deployed without a policy', () => {
    const output = `⚠  functions: No cleanup policy detected for repositories in us-east1.\n\n${CLEANUP_POLICY_ERROR}\n`;
    expect(deployOutcome(1, output)).toBe('deployed-without-cleanup-policy');
  });

  it('names both locations when two repositories have no policy', () => {
    const output = CLEANUP_POLICY_ERROR.replace('location us-east1', 'locations us-central1, us-east1');
    expect(deployOutcome(1, output)).toBe('deployed-without-cleanup-policy');
  });

  it('reads any other non-zero exit as failed', () => {
    expect(deployOutcome(1, 'Error: There was an error deploying functions')).toBe('failed');
    expect(deployOutcome(2, 'Error: An unexpected error has occurred.')).toBe('failed');
  });

  // firebase-tools 15.23.0 `release/index.js`: reporter.printErrors lists the
  // failed functions with logger.info (no `Error:` prefix), then
  // setupArtifactCleanupPolicies throws before "There was an error deploying
  // functions" is reached, so the policy error is the only `Error:` line.
  it('reads a partial failure that ends in the cleanup policy refusal as failed', () => {
    const output = [
      'i  functions: creating Node.js 22 (2nd Gen) function pyricHttpRegional(us-east1)...',
      '',
      'Functions deploy had errors with the following functions:',
      '\tpyricHttpEcho(us-central1)',
      '',
      '⚠  functions: No cleanup policy detected for repositories in us-central1, us-east1.',
      '',
      CLEANUP_POLICY_ERROR.replace('location us-east1', 'locations us-central1, us-east1'),
      '',
    ].join('\n');
    expect(deployOutcome(1, output)).toBe('failed');
  });

  it('reads a failed invoker set that ends in the cleanup policy refusal as failed', () => {
    const output = [
      'Unable to set the invoker for the IAM policy on the following functions:',
      '\tpyricHttpEcho(us-central1)',
      CLEANUP_POLICY_ERROR,
    ].join('\n');
    expect(deployOutcome(1, output)).toBe('failed');
  });

  it('reads the refusal through a colored Error: label', () => {
    expect(deployOutcome(1, `\u001b[1m\u001b[31mError:\u001b[39m\u001b[22m ${CLEANUP_POLICY_ERROR.slice('Error: '.length)}`)).toBe(
      'deployed-without-cleanup-policy',
    );
  });

  it('reads a signal or a missing status as failed', () => {
    expect(deployOutcome(null, CLEANUP_POLICY_ERROR)).toBe('failed');
  });
});

describe('inactiveFunctions', () => {
  it('names every fixture function that is missing or not ACTIVE', () => {
    expect(inactiveFunctions(['a', 'b', 'c', 'd'], new Map([['a', 'ACTIVE'], ['b', 'FAILED'], ['c', 'DEPLOYING']]))).toEqual([
      'b (FAILED)',
      'c (DEPLOYING)',
      'd (not deployed)',
    ]);
    expect(inactiveFunctions(['a'], new Map([['a', 'ACTIVE']]))).toEqual([]);
  });
});

describe('resolveFirebaseTools', () => {
  // The default reader resolves packages/playground's install, which CI's
  // conformance job does not install, so these cases inject the manifest.
  it('runs the bin script of the pinned version', () => {
    const tools = resolveFirebaseTools(() => ({
      version: FIREBASE_TOOLS_VERSION,
      bin: { firebase: './lib/bin/firebase.js' },
      dir: join('/workspace', 'node_modules', 'firebase-tools'),
    }));
    expect(tools).toEqual({
      version: FIREBASE_TOOLS_VERSION,
      bin: join('/workspace', 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'),
    });
  });

  it('refuses another version', () => {
    expect(() => resolveFirebaseTools(() => ({ version: '15.24.0', bin: { firebase: './lib/bin/firebase.js' } }))).toThrow(
      /firebase-tools 15\.24\.0 is installed; the capture needs 15\.23\.0/,
    );
  });
});

describe('capture state', () => {
  it('round-trips the run a later start must clean up, and clears it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'functions-http-state-')), 'capture-state.json');
    expect(readCaptureState(path)).toBeNull();
    const state = { runId: 'abc123', channel: 'pyric-fn-http-abc123', projectId: 'oracle', startedAt: '2026-10-28T00:00:00.000Z' };
    writeCaptureState(path, state);
    expect(readCaptureState(path)).toEqual(state);
    clearCaptureState(path);
    expect(readCaptureState(path)).toBeNull();
  });

  it('refuses a state file without a run id or channel', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'functions-http-state-')), 'capture-state.json');
    writeFileSync(path, JSON.stringify({ runId: 'abc123' }));
    expect(() => readCaptureState(path)).toThrow(/capture-state\.json is not a capture state/);
  });
});
