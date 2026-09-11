/**
 * What the Functions trigger runtime puts on the sandbox event stream.
 *
 * The runtime itself lives in `@pyric/cli` because it loads a project's own
 * trigger module from disk. The event vocabulary lives here, beside every
 * other service's, because the sandbox core derives the stream's service union
 * from these records and `@pyric/cli` depends downward on `pyric`.
 *
 * This file is not part of the deferred `pyric/functions` mirror beside it,
 * which stands in for `firebase/functions` callables. It is data, and the
 * deferred barrel does not re-export it.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const FUNCTIONS_EVENT_RECORD = {
  service: 'functions',
  operations: ['trigger_discovered', 'handler_fired', 'execution_finished'],
  target: {
    name: 'ref',
    description:
      "The trigger's reference pattern on discovery, and the synthetic event's concrete path once a handler fires.",
    always: false,
  },
} as const satisfies ServiceEventRecord;

/** Every operation the Functions trigger runtime emits. */
export type FunctionsEventOperation = (typeof FUNCTIONS_EVENT_RECORD)['operations'][number];
