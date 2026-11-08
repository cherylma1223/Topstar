import forms from '@tailwindcss/forms';
import containerQueries from '@tailwindcss/container-queries';

/**
 * Tailwind 配置（构建期编译）
 *
 * 此前是 index.html 里引用 cdn.tailwindcss.com 在浏览器里运行时编译，现改为构建期编译：
 * 不再依赖境外 CDN，也不会每次打开页面都在浏览器里重新生成样式。
 * 下面的 theme 与原来 index.html 里内联的 tailwind.config 完全一致，只有字体栈多了自托管字体和系统中文字体兜底。
 *
 * 注意：构建期编译只认源码里**完整出现**的 class 名。不要用 `bg-${color}-500` 这种拼接，
 * 要么写全 class 名，要么加到 safelist。
 */

// 自托管字体加载前后 / 加载失败时的系统中文字体兜底（国内主流设备都自带）
const SYSTEM_CJK = ['"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', '"Noto Sans CJK SC"'];

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'primary': '#138eec',
        'background-dark': '#101a22',
        'surface-dark': '#1e2933',
        'surface-lighter': '#2c3e50',
        'bubble-ai': '#233848',
        'bubble-user': '#138eec',
        'text-secondary': '#92b1c9',
      },
      fontFamily: {
        // 'Lexend Variable' / 'Noto Sans SC Variable' 是 @fontsource-variable 自托管字体的家族名
        display: ['"Lexend Variable"', 'Lexend', '"Noto Sans SC Variable"', '"Noto Sans SC"', ...SYSTEM_CJK, 'sans-serif'],
        body: ['"Noto Sans SC Variable"', '"Noto Sans SC"', ...SYSTEM_CJK, 'sans-serif'],
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.5s ease-out forwards',
        'shimmer': 'shimmer 2s infinite linear',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [forms, containerQueries],
};
