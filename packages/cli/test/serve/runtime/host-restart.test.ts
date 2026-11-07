import { describe, expect, it } from 'bun:test';
import { hostRestartedSincePageLoad, pageBootHostInstanceId } from '../../../src/serve/runtime/host-restart.js';

describe('host restart detection', () => {
  it('reads the boot stamped into the bundle before the init payload', () => {
    expect(pageBootHostInstanceId({ __PYRIC_HOST_INSTANCE_ID__: 'boot-1', __PYRIC_WORKER_INIT__: { instanceId: 'boot-0' } })).toBe('boot-1');
    expect(pageBootHostInstanceId({ __PYRIC_WORKER_INIT__: { instanceId: 'boot-0' } })).toBe('boot-0');
    expect(pageBootHostInstanceId({})).toBeUndefined();
  });

  it('counts a restart only when both boots are known and differ', () => {
    expect(hostRestartedSincePageLoad({ initialHostInstanceId: 'boot-1', currentHostInstanceId: 'boot-2' })).toBe(true);
    expect(hostRestartedSincePageLoad({ initialHostInstanceId: 'boot-1', currentHostInstanceId: 'boot-1' })).toBe(false);
    expect(hostRestartedSincePageLoad({ initialHostInstanceId: undefined, currentHostInstanceId: 'boot-2' })).toBe(false);
    expect(hostRestartedSincePageLoad({ initialHostInstanceId: 'boot-1', currentHostInstanceId: '' })).toBe(false);
  });
});
