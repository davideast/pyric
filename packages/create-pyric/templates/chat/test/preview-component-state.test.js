import React, { useEffect, useState } from 'react';
import { act, create } from 'react-test-renderer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { storePreviewComponent } from '../src/ui/chat/preview-component-state.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('stores a generated function component and renders its hooks in its own component', async () => {
  let generatedRenders = 0;

  function GeneratedTodoApp() {
    generatedRenders += 1;
    useState([]);
    return React.createElement('main', null, 'Todo app');
  }

  function PreviewHarness() {
    const [component, setComponent] = useState(null);
    useEffect(() => storePreviewComponent(setComponent, GeneratedTodoApp), []);
    return component
      ? React.createElement(component)
      : React.createElement('output', null, 'Compiling');
  }

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(PreviewHarness));
  });

  assert.equal(generatedRenders, 1);
  assert.deepEqual(renderer.toJSON().children, ['Todo app']);
});
