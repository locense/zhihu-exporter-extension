# 知乎导出器：Chrome/Edge 知乎文章、回答、收藏夹批量下载扩展

一个基于 Chrome / Edge Manifest V3 的知乎内容本地导出扩展，支持把知乎文章、回答、专栏和收藏夹导出为 Markdown、TXT 或包含本地图片的 ZIP。

搜索关键词：知乎导出器、知乎下载器、知乎文章导出、知乎回答导出、知乎收藏夹导出、知乎 Markdown、Zhihu Exporter、Zhihu Downloader。

[下载最新版本](https://github.com/locense/zhihu-exporter-extension/releases/latest)

## 功能

### 单篇导出

- 在知乎文章、专栏和回答页面注入导出工具栏。
- 支持 Markdown、TXT、Markdown + 图片 ZIP。
- Markdown 保留标题、作者、来源、发布时间、代码块、表格和公式。
- TXT 保留标题、作者、原文链接和正文。
- 图片支持 `src`、`srcset`、`data-original`、`data-actualsrc`、`data-src` 等常见字段。
- 图片按 URL 和内容哈希去重。
- 单张图片失败时保留远程地址并写入 `errors.json`，不会阻断整篇导出。

### 收藏夹批量导出

- 同时读取“我创建的收藏夹”和“我关注的收藏夹”，按 ID 合并去重。
- 支持按收藏夹来源筛选和按条目类型筛选。
- 支持多选收藏夹、多选条目、全选和反选。
- 支持滚动加载、按钮加载和分页链接读取。
- 支持公开和私密收藏夹，权限取决于当前浏览器登录态。
- ZIP 文件名和内部目录优先使用收藏夹真实名称，而不是数字 ID。
- 选择多个收藏夹时，可勾选“合并为一个压缩包”，生成一个总 ZIP。
- 批量完成后生成一个收藏夹 ZIP：

```text
收藏夹名/
├── index.md
├── 文章1.md
├── 文章2.md
├── assets/
└── export-report.json
```

### 任务管理

- 默认并发数为 1，可配置为 1 至 3。
- 支持任务间隔、自动重试、暂停、继续和取消。
- 任务状态写入 IndexedDB，浏览器重启后可恢复中断任务。
- 支持任务历史、批量归档状态、失败任务重试和失败报告下载。
- 105 篇批量任务已通过自动化压力测试。

## 安装

当前版本以 GitHub Release 附件形式发布。

1. 下载 Release 中的 `zhihu-exporter-extension-v1.0.2-load-me.zip`。
2. 解压 ZIP。
3. 选择解压后的 `zhihu-exporter-extension` 文件夹。
4. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。
5. 开启“开发者模式”或“开发人员模式”。
6. 点击“加载已解压的扩展程序”或“加载解压缩的扩展”。
7. 选择包含 `manifest.json` 的 `zhihu-exporter-extension` 文件夹。

不要直接把 ZIP 文件作为扩展加载。

## 使用

### 单篇文章或回答

打开知乎文章或回答页面，页面操作区或右下角会出现：

- `Markdown`
- `TXT`
- `图片 ZIP`
- `复制链接`

点击后任务会进入后台队列，可在扩展管理器中查看进度。

### 收藏夹

1. 打开扩展管理器。
2. 点击“刷新收藏夹”。
3. 使用“收藏夹来源”筛选“我创建的”或“我关注的”。
4. 读取并勾选需要导出的条目。
5. 选择导出格式。
6. 如需多个收藏夹合并下载，勾选“合并为一个压缩包”。
7. 开始批量下载。

## 隐私与权限

- 不申请 `cookies`、`webRequest`、`webRequestBlocking` 或 `debugger` 权限。
- 不读取、保存或上传明文 Cookie。
- 通过当前浏览器登录态打开隐藏知乎页面，不把账号信息发送到第三方服务器。
- 文件在本地生成并交给浏览器下载。
- 主要权限：`downloads`、`tabs`、`offscreen`、`alarms`。

## 开发

需要 Node.js 18 或更高版本。

```powershell
npm install
npm run verify
```

常用命令：

```powershell
npm test        # 单元测试
npm run build   # 构建 dist/
npm run check   # 检查 Manifest 和构建产物
npm run verify  # 测试、构建和静态检查
```

## 项目结构

```text
src/
├── background/   后台队列、下载、页面读取
├── content/      知乎页面解析和内容脚本
├── pages/        管理器与弹窗页面
├── shared/       常量、工具、IndexedDB、Markdown
├── manifest.json
└── offscreen.js
scripts/          构建和静态校验
tests/            单元测试
```

## 自动化测试

自动化测试覆盖扩展加载、单篇 Markdown/TXT/图片 ZIP、收藏夹标签解析、批量 ZIP 和 105 篇压力测试。

## 已知限制

- 第一版不导出知乎“想法”和视频，任务会标记为“暂不支持”。
- 知乎页面结构变化后，解析器可能需要更新选择器。
- 私密收藏夹必须保持有效登录状态。
- 图片请求可能因签名、Referer、风控或登录过期返回 403；此时 Markdown 会保留远程地址。
- 真实账号收藏夹、私密收藏夹和真实 100 篇以上收藏夹分页仍建议在登录浏览器中人工验证。

## 第三方组件

- [Turndown](https://github.com/mixmark-io/turndown)：HTML 转 Markdown。
- [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm)：表格等 GFM 支持。
- [fflate](https://github.com/101arrowz/fflate)：ZIP 生成。
- [esbuild](https://github.com/evanw/esbuild)：开发构建。

以上依赖均使用 MIT 许可证；发布或再分发前请保留对应许可证文本。

## 参考项目

功能设计参考了以下项目，但当前代码为独立实现，没有直接复制其源码：

- [chouheiwa/download-zhihu](https://github.com/chouheiwa/download-zhihu)
- [jnhu76/zhihu-collection-exporter](https://github.com/jnhu76/zhihu-collection-exporter)
- [Guyungy/Export-Zhihu-Collections](https://github.com/Guyungy/Export-Zhihu-Collections)
- [OrdoAbChao7/Zhihucrawler](https://github.com/OrdoAbChao7/Zhihucrawler)

## 许可证

当前仓库暂未指定开源许可证。发布或再分发前请自行确认第三方组件许可证和知乎平台规则。
