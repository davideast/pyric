/**
 * Reader for the optional project-level `pyric.json` configuration file.
 *
 * Configures defaults for `pyric sandbox` (such as a default `command`,
 * custom `port`, `ai` engine settings, or explicit `rules` paths) without
 * requiring CLI flags or magic process sniffing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowConfig } from '../serve/flow-config.js';
import type { RemoteAccessOptions } from '../serve/guard-policy.js';
import type { OwnersConfig } from '../serve/owners-config.js';
import type { PyricAiOptions } from '../serve/vite-ai-config.js';

interface PyricRulesConfig {
  firestore?: string;
  database?: string;
  storage?: string;
}

export interface PyricConfig {
  runtime?: { thresholds?: import('../serve/runtime/rate-threshold-config.js').ThresholdConfig };
  /** Listener Flow default and browser treatment modules. */
  flow?: FlowConfig;
  /** Which application frames a listener or operation owner keeps and shows first. */
  owners?: OwnersConfig;
  /** AI Logic mode, model, declarative engine, and OpenAI-compatible proxy upstream. */
  ai?: PyricAiOptions;
  /** Default command to execute under the sandbox if none is passed on CLI. */
  command?: string;
  /** Local port to bind the Pyric sandbox host. */
  port?: number;
  /** Path to Firestore, RTDB, or Storage rules files. */
  rules?: string | PyricRulesConfig;
  /** Project ID label for emulation. */
  project?: string;
  /** Require a per-boot session capability token on every local route in sandbox and bridge modes. */
  sessionToken?: boolean;
  /** Extra hostnames or leading-dot suffixes (`>= 2` labels) allowed past the DNS-rebinding guard. */
  allowedHosts?: string[];
  /** Explicit remote workstation / reverse-proxy access policy (`allowPeers`, `trustProxy`, `browserUnlock`). */
  remoteAccess?: RemoteAccessOptions;
  /** `pyric verify` settings. */
  verify?: {
    /** The dedicated RTDB instance `pyric verify --engine staging` replays against. */
    staging?: { project: string; rtdb: string };
  };
}

const ALLOWED_AI_KEYS = new Set(['mode', 'model', 'engine', 'proxyUpstream']);
const ALLOWED_AI_ENGINE_KINDS = new Set(['openai', 'gemini', 'scripted']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePyricAiConfig(rawAi: unknown): void {
  if (rawAi === undefined) return;
  if (!isPlainRecord(rawAi)) {
    throw new Error("pyric: invalid 'ai' in pyric.json: expected an object.");
  }
  for (const key of Object.keys(rawAi)) {
    if (!ALLOWED_AI_KEYS.has(key)) {
      throw new Error(
        `pyric: unknown 'ai.${key}' in pyric.json (expected mode, model, engine, or proxyUpstream).`,
      );
    }
  }
  if (rawAi.mode !== undefined && rawAi.mode !== 'sandbox' && rawAi.mode !== 'production') {
    throw new Error('pyric: invalid \'ai.mode\' in pyric.json: expected "sandbox" or "production".');
  }
  if (rawAi.model !== undefined && typeof rawAi.model !== 'string') {
    throw new Error("pyric: invalid 'ai.model' in pyric.json: expected a string.");
  }
  if (rawAi.proxyUpstream !== undefined && typeof rawAi.proxyUpstream !== 'string') {
    throw new Error("pyric: invalid 'ai.proxyUpstream' in pyric.json: expected a string.");
  }
  if (rawAi.engine !== undefined) {
    if (!isPlainRecord(rawAi.engine) || typeof rawAi.engine.kind !== 'string' || !ALLOWED_AI_ENGINE_KINDS.has(rawAi.engine.kind)) {
      throw new Error(
        'pyric: invalid \'ai.engine\' in pyric.json: expected an engine object with kind "openai", "gemini", or "scripted".',
      );
    }
  }
}

export async function readPyricConfig(cwd: string = process.cwd()): Promise<PyricConfig> {
  const path = join(cwd, 'pyric.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `pyric: failed to parse pyric.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('pyric: invalid pyric.json: expected a JSON object.');
  }
  validatePyricAiConfig(parsed.ai);
  return parsed as PyricConfig;
}
