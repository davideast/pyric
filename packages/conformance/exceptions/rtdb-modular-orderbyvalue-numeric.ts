import type { ObservationException } from './types.ts';

export const exception: ObservationException = {
  reason:
    'Prod rejected the query because the oracle project lacked the required .indexOn; the observation documents index enforcement rather than a directly matching matrix row.',
};
