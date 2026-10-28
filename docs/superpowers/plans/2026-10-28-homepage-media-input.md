# 首页统一转写输入框 Implementation Plan

**Goal:** 实现分享文案/媒体链接/本地文件统一提交，在线理解后下载并使用本地模型转写。

**Architecture:** React 输入暂存和编排层复用现有转写队列、结果页与历史存储；在线解析使用已有 OpenAI 兼容客户端；Rust 命令负责受控 URL 跳转、下载进程、取消与音轨验证。

**Tech Stack:** 当前 Tauri、React、TypeScript、Rust、reqwest、yt-dlp、FFmpeg；不添加框架或 SDK。

## Global Constraints

- 新界面中文；所有链接严格依赖在线模型；本地文件不依赖 API。
- 公开无需登录内容；不读取 Cookie；LLM 不生成命令和下载地址。
- 保留既有未提交改动；不推送或发布。

## Task 1: 在线解析与连接预设

- [x] 新建 `desktop/src/lib/media-input.ts` 和测试：提取原文 URL、解析 JSON、校验模型只返回输入中的 URL、限制长度和数量，超时与取消，明确中文错误。
- [x] `resolveMediaInput(text, connection, signal): Promise<ResolvedMediaLink[]>` 返回 `{url,platform}`；platform 为 bilibili/xiaohongshu/youtube/douyin/weibo/direct。
- [x] 新建 AI 连接预设并更新设置：DeepSeek 地址和模型候选；切换服务清空 Key；保留已有配置；增加用途说明。
- [x] 定向 Vitest 验证整段分享、重复、标点、编造 URL、无效 JSON、API 错误、取消与预设行为。

## Task 2: 原生媒体入口

- [x] 新建 `cmd/media_input.rs` 负责 URL/域名/地址和受控跳转；HTTP(S)，拒绝凭据和内网；直链探测媒体类型。
- [x] 新建 `cmd/media_download.rs` 提供 `download_media(url,requestId)`、`cancel_media_download(requestId)`；应用管理临时输出，独立并行读取 stdout/stderr，轮询取消，限制超时和错误输出。
- [x] 事件 `media-download-progress` 返回 `{requestId,stage,progress}`；返回 `{path,title,sourceUrl?}`，完成前用 FFmpeg 解码验证音轨。
- [x] 下载不读取用户 yt-dlp 配置/Cookie；输出与日志不暴露签名 URL；验证退出和清理行为。
- [x] 运行相关 Cargo 测试及编译，注册命令。

## Task 3: 输入框和任务编排

- [x] 重写 `idle-hero.tsx`：标题、多行输入、附件、选择文件、模型选择、发送、Command+Enter，保留快捷录音进行中的显示。
- [x] 新建 `hooks/use-media-composer.ts` 管理文本/附件暂存、提交快照、去重、逐项下载、失败单项重试、取消与防重入；混合任务 API 失败不阻止文件。
- [x] `session.tsx` 将选取/拖入改为暂存；增加准备阶段退出保护；`page.tsx` 保持失败/进度可见。
- [x] 提交固定 Preference 快照；全局 STT 切换锁覆盖准备/转写；队列保存使用实际快照。
- [x] 可选公开 `sourceUrl` 贯穿入队与存储；签名直链不保存；旧记录兼容。
- [x] 定向 UI/Hook 测试：暂存、失败保留、严格 API 门槛、本地独立、重试不重复、取消不入队、快照。

## Task 4: 集成与交付

- [x] 执行 TypeScript 检查、已有前端回归、Rust 相关测试、差异与格式检查。
- [x] 使用公共直链样本验证下载→音轨→Qwen→存储；YouTube 验证下载和音轨；逐平台记录可达性与限制，无法下载不能宣称成功。
- [x] 更新中文使用/验收记录；运行 `pnpm exec tauri build --bundles app`，更新 `outputs/Vibe Qwen.app` 并校验签名。
- [x] 说明真实 API 与平台验证范围；不索取或输出用户密钥。

## 验收范围与未解决项

2026-10-28：核心实现与本地打包完成，前端 209 项、Rust 83 项自动测试通过；真实 Qwen 集成测试额外通过。已在原生 App 中完成本地文件暂存、提交、转写、历史保存；没有 API Key 的链接提交会保留输入并提示。YouTube 下载和音轨验证通过，微博仅验证媒体信息提取。B站 HTTP 412、小红书无视频格式、抖音要求 Cookie，均仍未解决；未调用真实在线账户 API，最终重新签名后的历史扫描等待 macOS Documents 访问确认；不能宣称全部目标平台、在线请求与最终重启历史加载完整验收。详情见 `plans/homepage-media-input/homepage-media-input_002.md`。
