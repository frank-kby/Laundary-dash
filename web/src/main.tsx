import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource-variable/bricolage-grotesque/wght.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
