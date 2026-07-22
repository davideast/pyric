import { describe, expect, it } from 'bun:test';
import { synthesizeVirtualModule } from '../../../src/lib/preview/virtual-imports-plugin';

describe('firebase/database preview exports', () => {
  it('synthesizes the child-listener exports used by first-user app source', () => {
    const source = synthesizeVirtualModule('firebase/database');

    expect(source).toContain('export const onChildAdded = __m.onChildAdded;');
    expect(source).toContain('export const onChildChanged = __m.onChildChanged;');
    expect(source).toContain('export const onDisconnect = __m.onDisconnect;');
  });
});
