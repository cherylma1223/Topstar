# Topstar 前端（H5）

React 19 + Vite + Tailwind CSS（构建期编译）。前端**只**调用自家后端 `/api/v2/*`，不直接访问任何大模型，也不需要任何模型 API Key（Key 只在 `server/.env`）。

## 本地运行

前置：Node.js 22+。后端需先启动（默认 `:3001`，Vite 已代理 `/api`）。

```bash
npm install
npm run dev        # http://localhost:3000
```

## 构建

```bash
npm run build
```

`build` 依次执行：

1. `check:icons`：源码里用到的每个 Material Symbols 图标必须在子集字体里，否则构建失败。
2. `vite build`
3. `check:dist`：扫描产物，出现境外 CDN 域名 / 绝对外链 / importmap 即构建失败；对内容类外链（如 `drive.google.com`、`img1.baidu.com`）只给出警告。

## 零境外依赖说明（国内上线要求）

页面资源全部自托管，不依赖 Google Fonts / cdn.tailwindcss.com / esm.sh：

| 资源 | 方式 |
| --- | --- |
| Tailwind | `tailwind.config.js` + `postcss.config.js` 构建期编译，入口 `index.css` |
| 正文/标题字体 | `@fontsource-variable/noto-sans-sc`、`@fontsource-variable/lexend`（在 `index.tsx` 引入，woff2 随产物发布） |
| 图标字体 | `src/assets/fonts/material-symbols-outlined.subset.woff2`（约 12 KB，仅含源码用到的图标） |

### 新增/更换图标后

在源码里使用新的图标名后，需要重新生成子集字体：

```bash
pip install -r scripts/requirements-icons.txt   # 仅首次，且只有重新生成图标时才需要 Python
npm run build:icons
```

并把更新后的 `src/assets/fonts/material-symbols-outlined.subset.{woff2,json}` 一并提交。
`@fontsource-variable/material-symbols-outlined` 仅作为生成脚本读取完整字体的来源，不会进入产物。
开发时 `predev` 只会对缺失图标发出警告，`npm run build` 则会直接失败。

## 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-08 | 重写 README（原为 AI Studio 模板，含已失效的 `GEMINI_API_KEY` 说明）；记录去境外 CDN 后的构建方式（Tailwind 构建期编译、字体自托管、图标子集、`check:icons`/`check:dist`）。 |
