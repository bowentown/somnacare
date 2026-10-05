import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css'

// ── Service Worker 注册策略 ─────────────────────────────────────────
// 1. APK 原生环境不注册：资源本就在本地，SW 只会带来"更新后首开跑旧版"
//    （skipWaiting+clientsClaim 接管旧页面的错配，第七轮报告端到端实测）
//    与约 9MB 的重复缓存。
// 2. Web/PWA：autoUpdate 的 SW 接管页面时 reload 一次——没有这一步，
//    更新后的第一次打开必然渲染上一个版本。
// 3. dev 不注册：dev server 没有 sw.js，注册只会给每个页面留一条
//    "404 脚本加载失败"的 console 噪声（PWA 缓存只对构建产物有意义）
if (import.meta.env.PROD && 'serviceWorker' in navigator && !(window as any).Capacitor?.isNativePlatform?.()) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;   // 首次安装不重载
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* dev 下 /sw.js 不存在 */ });
  });
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
