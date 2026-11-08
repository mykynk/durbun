import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './i18n/foundation';
import { initDocumentEffects } from './app/bootstrap';
import { startConnection } from './data';
import { App } from './App';
import { AppBoundary } from './components/ErrorBoundary';

initDocumentEffects();
startConnection();

const rootEl = document.getElementById('root');
if (rootEl) {
  // Errors React recovers from (error boundaries) and the ones it cannot both reach the console, which the
  // Mac app writes to its diagnostic log.
  createRoot(rootEl, {
    onCaughtError: (error, info) => console.error('[durbun] caught render error', error, info.componentStack),
    onUncaughtError: (error, info) => console.error('[durbun] uncaught render error', error, info.componentStack),
  }).render(
    <StrictMode>
      <AppBoundary>
        <App />
      </AppBoundary>
    </StrictMode>,
  );
}
