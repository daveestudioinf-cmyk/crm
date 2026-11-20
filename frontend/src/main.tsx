import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

if (import.meta.env.PROD && 'serviceWorker' in navigator && navigator.onLine) {
  window.addEventListener('load', () => {
    if (navigator.onLine) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
