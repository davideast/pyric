import { modelOnPort } from './generation-ai-transport';
import { disconnectPort } from '../../../../../packages/cli/src/serve/worker/client/core';
import type { StreamingModel } from './generation-model';
import type { GenerationSpec } from './generation-types';

type Connection = {
  port: MessagePort;
  users: number;
  models: Map<string, StreamingModel>;
};

/** Each request pins a connection; a returning tab supplies the next request's
 * connection without disrupting a healthy stream already in progress. */
export function createAiConnections() {
  let current: Connection | undefined;
  let ready: (() => void) | undefined;
  const firstConnection = new Promise<void>(resolve => { ready = resolve; });
  function closeIfRetired(connection: Connection) {
    if (connection !== current && connection.users === 0) {
      disconnectPort(connection.port);
      connection.port.close();
      connection.models.clear();
    }
  }
  return {
    attach(port: MessagePort) {
      const previous = current;
      current = { port, users: 0, models: new Map() };
      ready?.();
      ready = undefined;
      if (previous) closeIfRetired(previous);
    },
    model(options: GenerationSpec['modelConfig']): StreamingModel {
      return {
        async generateContentStream(prompt, requestOptions) {
          await firstConnection;
          requestOptions?.signal?.throwIfAborted();
          const connection = current!;
          const key = JSON.stringify(options ?? null);
          if (!connection.models.has(key))
            connection.models.set(key, modelOnPort(connection.port, options));
          const model = connection.models.get(key)!;
          connection.users++;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            requestOptions?.signal?.removeEventListener('abort', release);
            connection.users--;
            closeIfRetired(connection);
          };
          requestOptions?.signal?.addEventListener('abort', release, { once: true });
          try {
            const result = await model.generateContentStream(prompt, requestOptions);
            return { ...result, response: result.response.finally(release) };
          } catch (error) {
            release();
            throw error;
          }
        },
      };
    },
  };
}
