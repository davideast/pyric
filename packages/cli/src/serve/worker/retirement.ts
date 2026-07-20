interface RetirementPort {
  postMessage(message: unknown): void;
}

interface WorkerRetirementOptions {
  closeWorker(): void;
  beforeAnnounce?(): Promise<void>;
  drainTimeoutMs?: number;
  schedule?: (run: () => void) => void;
}

export interface WorkerRetirement {
  connect(port: RetirementPort): void;
  disconnect(port: RetirementPort): void;
  track(port: RetirementPort, work: Promise<void>): void;
  trackDetached(work: Promise<void>): void;
  accepting(): boolean;
  retire(requester: RetirementPort, requestId: string, targetEpoch: string): Promise<void>;
}

/** Drain already-accepted port work before every page reloads onto a new worker. */
export function createWorkerRetirement(options: WorkerRetirementOptions): WorkerRetirement {
  const ports = new Set<RetirementPort>();
  const workByPort = new Map<RetirementPort, Promise<void>>();
  const detachedWork = new Set<Promise<void>>();
  const requests: Array<{ requester: RetirementPort; requestId: string }> = [];
  const schedule = options.schedule ?? ((run) => { setTimeout(run, 50); });
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
  let retiring = false;
  let announced = false;
  let announcedEpoch: string | null = null;
  let retirement: Promise<void> | null = null;

  const timeout = (work: Promise<void>): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Worker retirement drain timed out after ${drainTimeoutMs}ms.`)),
      drainTimeoutMs,
    );
    void work.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

  const failRequests = (error: Error): void => {
    for (const request of requests.splice(0)) {
      request.requester.postMessage({
        t: 'res', id: request.requestId, ok: false,
        error: { code: 'pyric/worker-retirement-timeout', message: error.message },
      });
    }
  };

  return {
    connect(port) {
      ports.add(port);
      if (announcedEpoch) {
        port.postMessage({ t: 'runtime-reload', epoch: announcedEpoch });
      }
    },
    disconnect(port) {
      ports.delete(port);
    },
    track(port, work) {
      workByPort.set(port, work);
      const settled = (): void => {
        if (workByPort.get(port) === work) workByPort.delete(port);
      };
      void work.then(settled, settled);
    },
    trackDetached(work) {
      detachedWork.add(work);
      void work.then(
        () => { detachedWork.delete(work); },
        () => { detachedWork.delete(work); },
      );
    },
    accepting: () => !retiring,
    async retire(requester, requestId, targetEpoch) {
      if (!/^[a-f0-9]{16}$/.test(targetEpoch)) {
        requester.postMessage({
          t: 'res', id: requestId, ok: false,
          error: { code: 'pyric/invalid-worker-epoch', message: 'Invalid replacement worker epoch.' },
        });
        return;
      }
      if (announced) {
        requester.postMessage({
          t: 'res', id: requestId, ok: true, value: { retiring: true },
        });
        requester.postMessage({ t: 'runtime-reload', epoch: announcedEpoch! });
        return;
      }
      requests.push({ requester, requestId });
      if (!retirement) {
        retiring = true;
        const acceptedWork = [...workByPort.values(), ...detachedWork];
        const attempt = { cancelled: false };
        retirement = timeout((async () => {
          await Promise.allSettled(acceptedWork);
          if (attempt.cancelled) return;
          await options.beforeAnnounce?.();
          if (attempt.cancelled) return;
          for (const request of requests.splice(0)) {
            request.requester.postMessage({
              t: 'res', id: request.requestId, ok: true, value: { retiring: true },
            });
          }
          announced = true;
          announcedEpoch = targetEpoch;
          for (const port of ports) {
            port.postMessage({ t: 'runtime-reload', epoch: targetEpoch });
          }
          schedule(options.closeWorker);
        })()).catch((error: unknown) => {
          attempt.cancelled = true;
          retiring = false;
          retirement = null;
          failRequests(error instanceof Error ? error : new Error(String(error)));
        });
      }
      await retirement;
    },
  };
}
