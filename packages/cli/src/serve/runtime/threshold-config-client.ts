import { stampedSessionToken } from './hosted-target.js';
import { readThresholdConfig, type ThresholdConfig } from './rate-threshold-config.js';

export interface LocalThresholdConfig {
  config: ThresholdConfig;
  revision: string;
}

export interface ThresholdConfigClient {
  read(): Promise<LocalThresholdConfig | null>;
  save(config: ThresholdConfig, revision: string): Promise<LocalThresholdConfig>;
}

interface ThresholdInitSummary {
  sessionToken?: unknown;
  remotePeer?: unknown;
  thresholds?: unknown;
}

/** Missing project capability means session-only settings; project errors remain errors. */
export function createThresholdConfigClient(
  fetcher: typeof fetch,
  options: { init?: Promise<ThresholdInitSummary | null> } = {},
): ThresholdConfigClient {
  let token: string | undefined;

  async function request(method: string, body?: unknown): Promise<LocalThresholdConfig> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const requestInit: RequestInit = { method, headers };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }
    const response = await fetcher('/__pyric/thresholds', requestInit);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read threshold settings.');
    if (typeof result.revision !== 'string') {
      throw new Error('Invalid threshold configuration response.');
    }
    return { config: readThresholdConfig(result.config), revision: result.revision };
  }

  return {
    async read() {
      const stamped = stampedSessionToken();
      if (options.init !== undefined) {
        let provided: ThresholdInitSummary | null;
        try {
          provided = await options.init;
        } catch {
          return null;
        }
        if (
          provided === null ||
          provided.remotePeer === true ||
          provided.thresholds !== true
        ) {
          return null;
        }
        token = typeof provided.sessionToken === 'string' ? provided.sessionToken : stamped;
        return request('GET');
      }
      const initRequest: RequestInit = {};
      if (stamped !== undefined) {
        initRequest.headers = { 'x-pyric-session-token': stamped };
      }
      const response = await fetcher('/__pyric/init.json', initRequest);
      const isJson = response.headers.get('content-type')?.includes('application/json') === true;
      if (
        response.status === 404 ||
        response.status === 401 ||
        response.status === 403 ||
        !isJson
      ) {
        return null;
      }
      if (!response.ok) throw new Error('Unable to connect to local threshold settings.');
      const init = (await response.json()) as ThresholdInitSummary;
      if (init.remotePeer === true || init.thresholds !== true) return null;
      token = typeof init.sessionToken === 'string' ? init.sessionToken : stamped;
      return request('GET');
    },
    save: (config, revision) => request('PUT', { config, revision }),
  };
}
