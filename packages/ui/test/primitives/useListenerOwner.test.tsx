import { describe, expect, it } from 'bun:test';
import { configureListenerAttribution } from 'pyric/sandbox/internal';
import { useListenerOwner } from '../../src/primitives/hooks/useListenerOwner.js';
import { act, renderHook } from '../helpers/render-hook.js';
import { FakeElement } from '../helpers/fake-element.js';

describe('useListenerOwner', () => {
  it('names the calling component from the render-phase call stack', () => {
    let captured: ReturnType<typeof useListenerOwner> | undefined;
    function OrdersTable() {
      captured = useListenerOwner();
      return null;
    }
    renderHook(() => OrdersTable(), undefined);

    expect(captured?.owner?.kind).toBe('component');
    if (captured?.owner?.kind !== 'component') throw new Error('expected a component owner');
    expect(captured.owner.name).toBe('OrdersTable');
  });

  it('builds the ancestor path outermost-first from an owner stack', () => {
    const { result } = renderHook(() =>
      useListenerOwner({
        captureOwnerStack: () =>
          '    at Dashboard (src/app/Dashboard.tsx:8:3)\n    at App (src/app/App.tsx:3:3)',
      }),
    );

    expect(result.current.owner?.kind).toBe('component');
    if (result.current.owner?.kind !== 'component') throw new Error('expected a component owner');
    expect(result.current.owner.path).toEqual(['App', 'Dashboard']);
  });

  it('omits component frames the owner stack format cannot parse', () => {
    const { result } = renderHook(() =>
      useListenerOwner({
        captureOwnerStack: () => '    at <anonymous>',
      }),
    );

    expect(result.current.owner?.kind).toBe('component');
    if (result.current.owner?.kind !== 'component') throw new Error('expected a component owner');
    expect(result.current.owner.path).toBeUndefined();
  });

  it('fills owner.element once ref is attached', () => {
    const { result } = renderHook(() => useListenerOwner());
    const element = new FakeElement('table');
    element.id = 'orders';

    act(() => {
      result.current.ref(element);
    });

    expect(result.current.owner?.kind).toBe('component');
    if (result.current.owner?.kind !== 'component') throw new Error('expected a component owner');
    expect(result.current.owner.element).toBe('#orders');
  });

  it('records no owner at all when attribution is off', () => {
    configureListenerAttribution('off');
    try {
      const { result } = renderHook(() => useListenerOwner());
      expect(result.current.owner).toBeUndefined();
    } finally {
      configureListenerAttribution('auto');
    }
  });
});
