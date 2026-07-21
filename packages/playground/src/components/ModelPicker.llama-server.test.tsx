import { describe, expect, test } from 'bun:test';
import { modelsForProvider } from './ModelPicker';

describe('ModelPicker llama.cpp discovery', () => {
  test('selects the live llama-server model catalogue for the picker', () => {
    const live = [{ id: 'ornith-35b', label: 'ornith-35b' }];
    const selected = modelsForProvider(
      'llamaServer',
      [{ id: 'default', label: 'Loaded model (llama.cpp)' }],
      [{ id: 'mistral', label: 'mistral' }],
      live,
    );
    expect(selected).toBe(live);
    expect(selected).toEqual([{ id: 'ornith-35b', label: 'ornith-35b' }]);
  });
});
