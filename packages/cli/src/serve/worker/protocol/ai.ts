/**
 * JSON-safe engine config for the worker host's AiBroker -- the wire form of
 * `pyric/ai`'s `EngineConfig`.
 */
export type AiEngineConfigWire =
  | { kind: 'scripted'; script?: Array<Record<string, unknown>> }
  | {
      kind: 'openai';
      baseUrl?: string;
      model?: string;
      modelMap?: Record<string, string>;
    }
  | { kind: 'gemini'; baseUrl?: string; apiKey?: string };

/** Runtime hint identifying the caller that produced an AI App Check claim (#1736). */
type AiAppCheckRuntime = 'browser' | 'server';

/**
 * The App Check claim an AI request from an app-backed handle carries, as
 * production reads `X-Firebase-AppCheck`: a token, or `null` when the handle
 * has none. The worker broker refuses a request whose claim has no valid
 * sandbox token. Requests from handles with no app send no claim and are not
 * gated.
 */
export interface AiAppCheckWire {
  token: string | null;
  runtime?: AiAppCheckRuntime;
  projectId?: string;
  appId?: string;
}
