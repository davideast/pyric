/**
 * A browser tab keeps the bundle and rules it loaded when the host restarts.
 * These helpers compare the host boot a page was served by with the boot that
 * answers it now, so the page can say it is stale.
 */

/** The page's host boot and the boot answering it now, once they differ. */
export interface HostRestart {
  readonly initialHostInstanceId: string;
  readonly currentHostInstanceId: string;
}

/** The globals a served page carries for the host boot that served it. */
export interface PageBootGlobals {
  __PYRIC_HOST_INSTANCE_ID__?: string;
  __PYRIC_WORKER_INIT__?: { instanceId?: string };
}

/** The host boot id this page was served by, if the page carries one. */
export function pageBootHostInstanceId(page: PageBootGlobals): string | undefined {
  // The id stamped into the bundle names the boot that built this code.
  const stamped = page.__PYRIC_HOST_INSTANCE_ID__;
  if (stamped !== undefined) return stamped;
  // A bundle without a stamp falls back to the boot that wrote the page's init payload.
  return page.__PYRIC_WORKER_INIT__?.instanceId;
}

function isBootId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `true` when both boot ids are known and the host answering now is a later boot. */
export function hostRestartedSincePageLoad(ids: {
  initialHostInstanceId: unknown;
  currentHostInstanceId: unknown;
}): ids is HostRestart {
  if (!isBootId(ids.initialHostInstanceId)) return false;
  if (!isBootId(ids.currentHostInstanceId)) return false;
  return ids.initialHostInstanceId !== ids.currentHostInstanceId;
}

/** The console line a stale tab prints once. */
export function hostRestartWarning(restart: HostRestart): string {
  return `[pyric] The host restarted since this page loaded (host ${restart.initialHostInstanceId} -> ${restart.currentHostInstanceId}). `
    + 'Reload this page to load the updated bundle and rules.';
}
