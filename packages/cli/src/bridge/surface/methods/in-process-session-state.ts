/**
 * Persisted session state folded into `.pyric/state/in-process.json`'s
 * `services` map alongside the sandbox's own persistable service buckets:
 * app session, held agent identity, sandbox clock, and AI Logic scripts.
 *
 * `sandbox.snapshot()` and `sandbox.loadSnapshot()` are keyed by registered
 * service name, and the `__pyric_cli_*` keys are never registered as services,
 * so the sandbox core passes them through untouched in both directions.
 */
import { AIError, getAI, type AI } from 'pyric/ai';
import {
  clearScripts,
  script as scriptEngine,
  scripts as scriptsEngine,
  type ScriptingEntry,
} from 'pyric/ai/scripting';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  getClock,
  isClockInstantInRange,
  type LocalSandbox,
  type SandboxClockMode,
  type SandboxClockState,
} from 'pyric/sandbox';

import {
  describeMatch,
  describeRespond,
  matcherFor,
  respondFor,
  type ScriptMatch,
  type ScriptResponse,
} from '../ai-logic-matchers.js';
import type { IdentityInput, IdentityMode, SurfaceIdentity } from '../identity.js';
import { resolveStoredUidIdentity } from '../stored-identity.js';
import type { SandboxSurfaceContext } from '../types.js';

export const APP_SESSION_SERVICE_KEY = '__pyric_cli_app_session';
export const AGENT_IDENTITY_SERVICE_KEY = '__pyric_cli_agent_identity';
export const CLOCK_STATE_SERVICE_KEY = '__pyric_cli_clock_state';
export const AI_LOGIC_SCRIPTS_SERVICE_KEY = '__pyric_cli_ai_logic_scripts';

interface PersistedAppSession {
  uid: string;
  tenantId: string | null;
}

interface PersistedAiLogicScript {
  match: ScriptMatch | null;
  response: ScriptResponse;
  consumed: boolean;
}

interface PersistedAiLogicState {
  scripts: PersistedAiLogicScript[];
}

const VALID_IDENTITY_MODES = new Set<IdentityMode>(['admin', 'uid', 'anonymous', 'default']);
const VALID_CLOCK_MODES = new Set<SandboxClockMode>(['wall', 'fixed', 'offset']);

const hydratedIdentityBySandbox = new WeakMap<LocalSandbox, IdentityInput>();
const hydrationGenerationBySandbox = new WeakMap<LocalSandbox, number>();
const currentIdentityForSave = new WeakMap<LocalSandbox, IdentityInput>();
const syncedGenerationByIdentity = new WeakMap<SurfaceIdentity, number>();
const touchedAiSandboxes = new WeakSet<LocalSandbox>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersistedAppSession(value: unknown): value is PersistedAppSession {
  if (!isPlainRecord(value)) return false;
  if (typeof value.uid !== 'string' || value.uid.length === 0) return false;
  return value.tenantId === null || typeof value.tenantId === 'string';
}

function parsePersistedIdentity(value: unknown): IdentityInput | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.mode !== 'string' || !VALID_IDENTITY_MODES.has(value.mode as IdentityMode)) {
    return null;
  }
  const mode = value.mode as IdentityMode;
  if (mode !== 'uid') {
    return { mode };
  }
  if (typeof value.uid !== 'string' || value.uid.length === 0) {
    return null;
  }
  const out: IdentityInput = { mode: 'uid', uid: value.uid };
  if (typeof value.tenant === 'string' && value.tenant.length > 0) {
    out.tenant = value.tenant;
  }
  if (isPlainRecord(value.claims)) {
    out.claims = { ...value.claims };
  }
  return out;
}

function isPersistedClockState(value: unknown): value is SandboxClockState {
  if (!isPlainRecord(value)) return false;
  if (typeof value.mode !== 'string' || !VALID_CLOCK_MODES.has(value.mode as SandboxClockMode)) {
    return false;
  }
  if (typeof value.fixedAt !== 'number' || !Number.isFinite(value.fixedAt)) return false;
  if (typeof value.offsetMs !== 'number' || !Number.isFinite(value.offsetMs)) return false;
  if (value.mode === 'fixed' && !isClockInstantInRange(value.fixedAt)) return false;
  return true;
}

function parseScriptMatch(value: unknown): ScriptMatch | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value)) return undefined;
  const out: ScriptMatch = {};
  if (value.substring !== undefined) {
    if (typeof value.substring !== 'string') return undefined;
    out.substring = value.substring;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') return undefined;
    out.model = value.model;
  }
  if (out.substring === undefined && out.model === undefined) return null;
  return out;
}

function parseScriptResponse(value: unknown): ScriptResponse | null {
  if (!isPlainRecord(value)) return null;
  if (value.type === 'text' && typeof value.payload === 'string') {
    return { type: 'text', payload: value.payload };
  }
  if (value.type === 'json' && isPlainRecord(value.payload)) {
    return { type: 'json', payload: { ...value.payload } };
  }
  if (value.type === 'error' && isPlainRecord(value.payload)) {
    const code = value.payload.code;
    const message = value.payload.message;
    if (typeof code === 'number' && Number.isFinite(code) && typeof message === 'string') {
      return { type: 'error', payload: { code, message } };
    }
  }
  return null;
}

/** Capture the signed-in app session for snapshot persistence, or null when signed out. */
export function captureAppSession(sandbox: LocalSandbox): PersistedAppSession | null {
  const auth = getAuth(sandbox);
  const uid = auth.currentUser?.uid ?? null;
  if (uid === null) return null;
  return { uid, tenantId: authSandbox.getTenantId(auth) };
}

/** Restore the signed-in app session and tenant scope when the uid still exists. */
export function restoreAppSession(sandbox: LocalSandbox, stored: unknown): void {
  if (!isPersistedAppSession(stored)) return;
  const auth = getAuth(sandbox);
  const exists = authSandbox.exportUsers(auth).some((user) => user.uid === stored.uid);
  if (!exists) return;
  authSandbox.restoreSession(auth, stored.uid);
  authSandbox.setTenantId(auth, stored.tenantId);
}

/** Restore persisted agent identity metadata for `sandbox` after loading `in-process.json`. */
export function restoreAgentIdentity(sandbox: LocalSandbox, stored: unknown): void {
  const nextGen = (hydrationGenerationBySandbox.get(sandbox) ?? 0) + 1;
  hydrationGenerationBySandbox.set(sandbox, nextGen);
  const parsed = parsePersistedIdentity(stored);
  if (parsed === null || parsed.mode === 'default') {
    hydratedIdentityBySandbox.delete(sandbox);
    currentIdentityForSave.delete(sandbox);
    return;
  }
  hydratedIdentityBySandbox.set(sandbox, parsed);
  currentIdentityForSave.set(sandbox, parsed);
}

/** Hydrate `ctx.identity` once per load generation when `ctx.identity` is still default. */
export function syncHydratedAgentIdentity(ctx: SandboxSurfaceContext): void {
  const gen = hydrationGenerationBySandbox.get(ctx.sandbox);
  if (gen === undefined) return;
  if (syncedGenerationByIdentity.get(ctx.identity) === gen) return;
  syncedGenerationByIdentity.set(ctx.identity, gen);
  const hydrated = hydratedIdentityBySandbox.get(ctx.sandbox);
  if (hydrated === undefined) return;
  if (ctx.identity.describe().mode !== 'default') return;
  ctx.identity.switchTo(resolveStoredUidIdentity(ctx, hydrated));
}

/** Record the latest raw agent identity on `sandbox` so `saveSandboxSnapshot` persists it. */
export function recordAgentIdentityForSave(sandbox: LocalSandbox, raw: IdentityInput): void {
  if (raw.mode === 'default') {
    currentIdentityForSave.delete(sandbox);
    return;
  }
  currentIdentityForSave.set(sandbox, raw);
}

/** Capture the held agent identity for snapshot persistence, or null in default mode. */
export function captureAgentIdentity(sandbox: LocalSandbox): IdentityInput | null {
  const held = currentIdentityForSave.get(sandbox);
  if (held === undefined || held.mode === 'default') return null;
  return held;
}

/** Capture non-wall sandbox clock state for snapshot persistence. */
export function captureClockState(sandbox: LocalSandbox): SandboxClockState | null {
  const state = getClock(sandbox).capture();
  if (state.mode === 'wall') return null;
  return state;
}

/** Restore persisted sandbox clock state onto `sandbox`. */
export function restoreClockState(sandbox: LocalSandbox, stored: unknown): void {
  if (stored === null || stored === undefined) {
    getClock(sandbox).reset();
    return;
  }
  if (!isPersistedClockState(stored)) return;
  getClock(sandbox).restore(stored);
}

function quietGetAI(sandbox: LocalSandbox): AI {
  const originalInfo = console.info;
  console.info = () => {};
  try {
    return getAI(sandbox);
  } finally {
    console.info = originalInfo;
  }
}

/** Mark that `ai_logic` methods ran on `sandbox` so `captureAiLogicScripts` inspects its queue. */
export function markAiLogicTouched(sandbox: LocalSandbox): void {
  touchedAiSandboxes.add(sandbox);
  try {
    quietGetAI(sandbox);
  } catch (error) {
    if (error instanceof AIError) return;
    throw error;
  }
}

/** Capture queued AI Logic scripts when `sandbox` has touched AI Logic. */
export function captureAiLogicScripts(sandbox: LocalSandbox): PersistedAiLogicState | null {
  if (!touchedAiSandboxes.has(sandbox)) return null;
  let slots;
  try {
    slots = scriptsEngine(quietGetAI(sandbox));
  } catch (error) {
    if (error instanceof AIError) return null;
    throw error;
  }
  const scripts: PersistedAiLogicScript[] = [];
  for (const slot of slots) {
    const rawMatch = describeMatch(slot.entry.match);
    let match: ScriptMatch | null = null;
    if (rawMatch !== null && !('pattern' in rawMatch)) {
      const candidate: ScriptMatch = {};
      if (typeof rawMatch.substring === 'string') candidate.substring = rawMatch.substring;
      if (typeof rawMatch.model === 'string') candidate.model = rawMatch.model;
      if (candidate.substring !== undefined || candidate.model !== undefined) {
        match = candidate;
      }
    }
    const rawResponse = describeRespond(slot.entry.respond);
    const response = parseScriptResponse(rawResponse);
    if (response === null) continue;
    scripts.push({ match, response, consumed: slot.consumed });
  }
  if (scripts.length === 0) return null;
  return { scripts };
}

/** Restore queued AI Logic scripts onto `sandbox` without opening AI when none were saved. */
export function restoreAiLogicScripts(sandbox: LocalSandbox, stored: unknown): void {
  if (!isPlainRecord(stored) || !Array.isArray(stored.scripts) || stored.scripts.length === 0) {
    return;
  }
  const entries: ScriptingEntry[] = [];
  for (const item of stored.scripts) {
    if (!isPlainRecord(item)) continue;
    if (item.consumed === true) continue;
    const match = parseScriptMatch(item.match);
    if (match === undefined) continue;
    const response = parseScriptResponse(item.response);
    if (response === null) continue;
    const matcher = matcherFor(match ?? {});
    const respond = respondFor(response);
    if (matcher === undefined) {
      entries.push({ respond });
    } else {
      entries.push({ match: matcher, respond });
    }
  }
  if (entries.length === 0) return;
  touchedAiSandboxes.add(sandbox);
  try {
    const ai = quietGetAI(sandbox);
    clearScripts(ai);
    scriptEngine(ai, entries);
  } catch (error) {
    if (error instanceof AIError) return;
    throw error;
  }
}
