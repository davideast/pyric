import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/app';
import './dev/test-notification';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
