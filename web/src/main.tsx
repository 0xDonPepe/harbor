import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { moveToHttpsIfTrusted } from './app/https';
import './styles.css';

// decision 164: a trusted https address wins over plain http (escape hatch: ?skiphttps)
void moveToHttpsIfTrusted().then((leaving) => {
  if (leaving) return;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
