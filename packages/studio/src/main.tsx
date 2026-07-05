import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Pyric Studio: #root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
