import { readThresholdConfig, type ThresholdConfig } from './rate-threshold-config.js';
import { stampedSessionToken } from './hosted-target.js';
export interface LocalThresholdConfig { config: ThresholdConfig; revision: string }
export interface ThresholdConfigClient {
  read(): Promise<LocalThresholdConfig | null>;
  save(config: ThresholdConfig, revision: string): Promise<LocalThresholdConfig>;
}
/** Missing project capability means session-only settings; project errors remain errors. */
export function createThresholdConfigClient(fetcher: typeof fetch): ThresholdConfigClient {
  let token: string | undefined;
  async function request(method: string, body?: unknown): Promise<LocalThresholdConfig> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const response = await fetcher('/__pyric/thresholds', { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read threshold settings.');
    if (typeof result.revision !== 'string') throw new Error('Invalid threshold configuration response.');
    return { config: readThresholdConfig(result.config), revision: result.revision };
  }
  return {
    async read() {
      const stamped = stampedSessionToken();
      const response = stamped !== undefined
        ? await fetcher('/__pyric/init.json', { headers: { 'x-pyric-session-token': stamped } })
        : await fetcher('/__pyric/init.json');
      if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return null;
      if (!response.ok) throw new Error('Unable to connect to local threshold settings.');
      const init = await response.json();
      if (init.thresholds !== true) return null;
      token = typeof init.sessionToken === 'string' ? init.sessionToken : stamped;
      return request('GET');
    },
    save: (config, revision) => request('PUT', { config, revision }),
  };
}
