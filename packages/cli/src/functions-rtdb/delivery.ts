export interface RtdbTriggerDelivery {
  subscribe(
    path: string,
    listener: (value: unknown) => void,
    onError?: (error: unknown) => void,
  ): () => void;
}
