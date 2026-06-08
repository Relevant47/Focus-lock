import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

// Surface errors that React's boundaries can't catch (async handlers, IPC
// callbacks, module-load failures) by writing directly to the DOM. Without
// this, a JS error before React mounts leaves the window completely blank
// with no clue what went wrong — and the WKWebView inspector isn't always
// accessible in production builds.
function showFatal(label: string, detail: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  const card = document.createElement('div');
  card.style.cssText =
    'position:fixed;inset:24px;padding:20px;background:#1a0a0a;color:#ffd4d4;' +
    'border:1px solid #d44;border-radius:10px;font-family:-apple-system,monospace;' +
    'font-size:12px;line-height:1.55;z-index:2147483647;overflow:auto;white-space:pre-wrap';
  card.textContent = `[${label}]\n\n${detail}`;
  document.body.appendChild(card);
}

window.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[window.error]', event.error ?? event.message, event.filename, event.lineno);
  showFatal('window.error',
    `${event.message}\nat ${event.filename}:${event.lineno}\n\n${event.error?.stack ?? ''}`);
});
window.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', event.reason);
  const r = event.reason;
  showFatal('unhandledrejection',
    typeof r === 'object' && r !== null
      ? `${(r as Error).name ?? ''}: ${(r as Error).message ?? String(r)}\n\n${(r as Error).stack ?? ''}`
      : String(r));
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
