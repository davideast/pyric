import type { RemoteRtdb } from '../remote/index.js';
import type { RtdbTriggerDelivery } from './execution.js';

/** Existing remote RTDB value subscriptions adapted to the execution seam. */
export class RemoteRtdbTriggerDelivery implements RtdbTriggerDelivery {
  readonly #rtdb: Pick<RemoteRtdb, 'onValue'>;

  constructor(rtdb: Pick<RemoteRtdb, 'onValue'>) {
    this.#rtdb = rtdb;
  }

  subscribe(
    path: string,
    listener: (value: unknown) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    return this.#rtdb.onValue(
      path,
      (snapshot) => listener(snapshot.value),
      onError,
    );
  }
}
