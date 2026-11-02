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

initDocumentEffects();
startConnection();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
