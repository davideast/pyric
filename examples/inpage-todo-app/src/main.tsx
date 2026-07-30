import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { App } from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </React.StrictMode>
  );
}
