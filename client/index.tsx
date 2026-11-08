import React from 'react';
import { createRoot } from 'react-dom/client';
// 自托管字体（取代 Google Fonts）：按 unicode-range 分片，只下载页面用到的字符
import '@fontsource-variable/noto-sans-sc/index.css';
import '@fontsource-variable/lexend/index.css';
// 全局样式：Tailwind（构建期编译）+ 图标字体
import './index.css';
import App from './App.tsx';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
