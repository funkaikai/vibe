# Qwen 桌面集成验收

日期：2026-10-27。环境：macOS 26.6.2 / Apple Silicon。

## 自动验证

- `pnpm test`：27 个文件、134 项测试通过。
- `pnpm build`：TypeScript 与 Vite 生产构建通过。
- `cargo test -p vibe`：70 项通过；真实权重测试默认忽略，另行执行。
- `qwen::transcription::tests::real_model_transcribes_media --ignored --nocapture`：分别以中文 WAV 和 MP4 执行，均通过。
- `uv run plans/qwen3-asr/qwen3-asr_001.py`：13 项原生准备与下载工具验证通过。
- `pnpm exec tauri build --bundles app`：Apple Silicon 发布包构建通过。
- 交付 App 使用本地 ad-hoc 签名，`codesign --verify --deep --strict` 通过，并已重新启动验证。
- `git diff --check`：通过。

真实后端测试覆盖完整文件 SHA256 校验、FFmpeg 解码、Qwen 子进程、中文文本、分段事件、单调时间范围与最终 100% 进度。调试构建对 4.7 GB 模型执行软件 SHA256 较慢，两次测试各约 166 秒；这不是原生推理耗时。CLI 推理耗时见 `qwen3-asr_002.md`。

## 原生 App 操作

已使用实际打包的 `Vibe Qwen.app` 完成以下操作：

- 中文首屏、模型管理页及实际安装状态显示正常。
- 下载中取消后返回可操作状态，不自动切换到未下载的模型。
- 选择完整的 Qwen3-ASR-1.7B，CPU 状态固定显示开启；切回 Whisper 后恢复原有 GPU 偏好。
- 导入中文 WAV 和 MP4，均得到预期中文，并保存到独立的 `Documents/Vibe Qwen`。
- 较长音频转写中取消，Qwen 进程退出，任务未被标为成功。
- 取消后点击新建立即回到导入页，再次导入 WAV 成功转写。
- 重启后仍选择 Qwen，重新转写成功。
- 切回 Whisper Small，真实 WAV 转写成功；再切回 Qwen 成功。
- Qwen 转写后切到 Whisper，API 可直接启动并关闭；没有残留的 Qwen 状态阻断。

新建任务的视图切换改为直接显示目标视图，避免在原生 WebView 中等待退出动画时长时间显示空白结果页；页面回归测试与原生操作均已覆盖。

两种媒体的 Qwen 输出：

```text
你好，这是一段中文语音转文字的测试。这个应用可以在本地识别音频和视频，所有内容都保存在自己的电脑上。
```

## 范围

样例是短中文合成语音，只证明完整接入及基本工作流正常。尚未评估真实会议、方言、噪音或长录音的识别率，也未做与 Whisper 的准确率对比。Qwen 使用 CPU / Accelerate，时间范围是 20 秒输入分段的粗范围，不是精确字幕对齐；手机接力、HTTP API、翻译和说话人分离不在本次 Qwen 支持范围。

没有替换 `/Applications/vibe.app`，没有向 GitHub 提交或推送本次改动。
