import { readThresholdConfig, type ThresholdConfig } from './rate-threshold-config.js';
export interface LocalThresholdConfig { config: ThresholdConfig; revision: string }
export interface ThresholdConfigClient {
  read(): Promise<LocalThresholdConfig | null>;
  save(config: ThresholdConfig, revision: string): Promise<LocalThresholdConfig>;
}
/** Missing project capability means session-only settings; project errors remain errors. */
export function createThresholdConfigClient(fetcher: typeof fetch): ThresholdConfigClient {
  let token: string | undefined;
  async function request(method: string, body?: unknown): Promise<LocalThresholdConfig> {
    const response = await fetcher('/__pyric/thresholds', { method, headers: { 'x-pyric-session-token': token!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read threshold settings.');
    if (typeof result.revision !== 'string') throw new Error('Invalid threshold configuration response.');
    return { config: readThresholdConfig(result.config), revision: result.revision };
  }
  return {
    async read() {
      const response = await fetcher('/__pyric/init.json');
      if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return null;
      if (!response.ok) throw new Error('Unable to connect to local threshold settings.');
      const init = await response.json();
      if (init.thresholds !== true) return null;
      if (typeof init.sessionToken !== 'string') throw new Error('Reload to reconnect to local threshold settings.');
      token = init.sessionToken;
      return request('GET');
    },
    save: (config, revision) => request('PUT', { config, revision }),
  };
}
