/**
 * The `functions` deploy provider — the FIRST wrap, chosen to forge the contract
 * because it's the hardest existing shape: flag-driven (it reads `--source` /
 * `--config`, NOT firebase.json), and its config-resolution can fail as a usage
 * error before any network call. If the contract carries functions cleanly, it
 * carries the firebase.json-driven providers too.
 */
import { resolve as resolvePath } from 'node:path';
import { createFunctionsDeployTools } from '../tools.js';
import type { DeployProvider, ConfigSource, ResolveResult } from '../provider.js';
import { SCOPES } from '../../credentials/core/scopes.js';

/** The args `functions_deploy` expects (deploy/tools.ts). */
interface FunctionsArgs {
  localDir: string;
  functions: unknown;
}

export const functionsProvider: DeployProvider<FunctionsArgs> = {
  target: 'functions',
  summary: 'Deploy Cloud Functions from a source directory',
  operations: [{ name: 'deploy', default: true, toolName: 'functions_deploy' }],
  requiredScope: SCOPES.cloudPlatform,
  requiredApis: [
    'cloudfunctions.googleapis.com',
    'cloudbuild.googleapis.com',
    'run.googleapis.com',
    'artifactregistry.googleapis.com',
    'eventarc.googleapis.com',
  ],
  tools: (scope) => createFunctionsDeployTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<FunctionsArgs>> {
    const flagSource = src.flags.get('source');
    if (typeof flagSource !== 'string' || flagSource.length === 0) {
      return { ok: false, message: '--source <dir> is required.' };
    }
    const flagConfig = src.flags.get('config');
    if (typeof flagConfig !== 'string' || flagConfig.length === 0) {
      return { ok: false, message: '--config <json|path> is required (FunctionDeployConfig[]).' };
    }
    let functions: unknown;
    try {
      functions = flagConfig.trim().startsWith('[')
        ? JSON.parse(flagConfig)
        : JSON.parse(await src.readFile(resolvePath(src.cwd, flagConfig)));
    } catch (e) {
      return {
        ok: false,
        message: `failed to parse --config: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Single unit today; the dispatcher loops, so multi-unit is free later.
    return { ok: true, units: [{ localDir: resolvePath(src.cwd, flagSource), functions }] };
  },
};
