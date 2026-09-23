import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installExternalLinkHandler } from './components/shared';
import { startJankRecorder } from './lib/jank';
import './styles/index.css';

// 外链点击必须在 window 捕获阶段接管,抢在 Pake 壳注入的 document 拦截器之前
installExternalLinkHandler();
// 卡顿记录器:主线程冻结 ≥500ms 就连现场一起记下(见 lib/jank.ts)
startJankRecorder();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
