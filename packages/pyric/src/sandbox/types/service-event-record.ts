/**
 * The shape one service declares so the sandbox core knows what that service
 * puts on the event stream.
 *
 * A record is authored next to the service it describes
 * (`packages/pyric/src/<surface>/events.ts`), the way one tool method is one
 * record file. The sandbox core derives the service union and each service's
 * operation enum from those declarations rather than restating them, so a
 * service cannot emit an operation it never declared and cannot be added to
 * the stream vocabulary without declaring one.
 */

/** What a service event's `path` addresses, in that service's own scheme. */
export interface ServiceEventTarget {
  /** The addressing scheme's own name for the target, e.g. `uid`, `fullPath`. */
  readonly name: string;
  /** What the target names, for a consumer rendering the event. */
  readonly description: string;
  /** Whether every operation this service emits carries a target. */
  readonly always: boolean;
}

/** One service's declaration of its slice of the event stream. */
export interface ServiceEventRecord<
  Service extends string = string,
  Operation extends string = string,
> {
  /** The service name that appears on the event and in its provenance. */
  readonly service: Service;
  /** Every operation this service emits, in no significant order. */
  readonly operations: readonly Operation[];
  /** What the event's `path` addresses. */
  readonly target: ServiceEventTarget;
}
