# Qwen3-ASR-1.7B Implementation Plan

**Goal:** 在 macOS 的 Vibe fork 中下载、选择并离线使用官方 Qwen3-ASR-1.7B，支持音频和视频转写。

**Architecture:** 桌面端保留现有 Whisper 服务，新增独立的 Qwen CLI 子进程适配器。Qwen 模型以完整目录存储，固定官方版本和文件校验值；音视频通过现有 FFmpeg 解码，分段调用本地引擎，返回现有 Transcript 结构。

**Tech Stack:** Tauri / Rust / React，FFmpeg，antirez/qwen-asr 的 macOS Accelerate CPU 实现。Python 仅用于开发时准备原生程序，不是 App 运行依赖。

## Global Constraints

- 模型必须是 `Qwen/Qwen3-ASR-1.7B` 的原始官方权重，不替换量化模型或云服务。
- 固定模型版本 `7278e1e70fe206f11671096ffdd38061171dd6e5`。
- 固定引擎版本 `924694251d9e0f18e5d86bbd06aa3ab5f870002d`，携带 MIT 许可证。
- 新界面使用简体中文，默认中文识别。
- 独立 App 名称、标识符和 URL scheme，避免影响已安装的官方 Vibe；禁用上游自动更新。
- 时间范围是输入分段的粗时间范围，不宣称词级对齐。

## Contracts

- `model.path` 对 Qwen 表示目录；`get_model_metadata` 返回 `format=safetensors, engine=qwen3-asr`。
- `qwen_model_status` 返回 `{path, installed, reason}`。
- `list_qwen_models` 返回 `{name, path, valid, reason}[]`，与现有模型枚举合并。
- `download_qwen_model` 复用下载结果 `{status: completed, path}` / `{status: cancelled}`。
- `load_model` 完整校验固定文件 SHA256，保存活动 Qwen 目录并释放旧 Whisper 服务。
- `transcribe` 根据活动引擎路由，Qwen 返回现有 `Transcript`，发出 `new_segment` / 进度事件。
- 取消终止并回收 FFmpeg / Qwen 子进程，返回 `cancelled` 错误；失败不标记为转写完成。

## Task 1: 原生引擎与权重准备

- [x] `scripts/prepare_qwen.py` 获取固定源码、核对校验值、构建带 Accelerate 的 sidecar。
- [x] `resources/qwen3-asr-1.7b.json` 固定官方文件大小及 SHA256。
- [x] `scripts/download_qwen_model.py` 实现下载与校验；全部 7 个文件通过固定 SHA256 校验。
- [x] 用中文 WAV / 视频解码后的音频验证原生引擎，记录输出和耗时。

## Task 2: 桌面后端

- [x] `src/qwen/model.rs` 负责固定模型目录与完整性检查，`src/qwen/mod.rs` 提供下载命令。
- [x] `src/qwen/transcription.rs` 有界分片、子进程退出/取消、结果与事件转换。
- [x] `setup.rs` / `cmd/server_cmd.rs` / `cmd/transcribe.rs` 接入活动引擎路由。
- [x] 验证目录损坏、路径边界、取消和无效输入。

## Task 3: 模型管理

- [x] 设置页新增 Qwen 下载及切换入口，展示安装/使用/错误状态。
- [x] 模型列表兼容目录，并实测重启后保持已选模型。
- [x] 禁止向 Qwen 静默传入不支持的翻译、词级时间戳和说话人选项。
- [x] 保留现有 Whisper 切换逻辑，并设置中文默认值。

## Task 4: 集成验收

- [x] 前端 `pnpm test`、`pnpm build`：134 项测试通过。
- [x] Rust 聚焦测试与原生 App 构建：70 项通过，另外分别运行真实 WAV / MP4 测试通过；发布构建成功。
- [x] 打包独立的 Vibe Qwen.app，实际音频与视频转写。
- [x] 检查下载取消、转写取消、重启后的选择和切换回 Whisper。
- [x] `git diff --check`，补充使用说明与真实验证记录。

已在原生 App 检查中文首屏、下载取消、真实音视频转写、取消后再新建、重启选择及 Whisper 往返切换。原生与桌面集成验收分别见 `qwen3-asr_002.md` 和 `qwen3-asr_003.md`。
