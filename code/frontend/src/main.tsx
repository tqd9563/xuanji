import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installExternalLinkHandler } from './components/shared';
import './styles/index.css';

// 外链点击必须在 window 捕获阶段接管,抢在 Pake 壳注入的 document 拦截器之前
installExternalLinkHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
