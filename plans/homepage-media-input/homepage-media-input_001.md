# 首页统一输入验证入口

脚本 `homepage-media-input_001.py` 使用 Python 标准库，按组调用仓库已有测试和编译检查，不在 Python 中重写产品解析、下载或转写逻辑。脚本从自身位置确定仓库，不依赖调用者当前目录；所有命令通过参数数组启动，不使用 Shell。

## 前提

- 本机已有 uv、pnpm、Rust/Cargo；前端依赖与 Rust 构建资源已按仓库说明准备。
- 在 macOS Apple Silicon 上执行原生测试；编译 Qwen 原生集成需要已有 FFmpeg 和 sidecar 资源。
- 无需提供在线 API Key。默认测试使用受控接口响应，不会调用 DeepSeek 或其他在线模型，不读取本机个人配置中的凭据。

## 常规命令

在仓库根目录运行：

```sh
uv run plans/homepage-media-input/homepage-media-input_001.py
```

默认依次执行 `frontend`、`rust`、`checks`。可指定一个或多个分组：

```sh
uv run plans/homepage-media-input/homepage-media-input_001.py frontend checks
uv run plans/homepage-media-input/homepage-media-input_001.py rust --offline
```

| 分组 | 实际验证 |
| --- | --- |
| `frontend` | Vitest：分享文本提取/模型响应校验、AI 客户端和 DeepSeek 预设、设置页、输入编排和取消/重试、首页交互与模型选择、页面切换及历史记录兼容 |
| `rust` | `cargo test -p vibe cmd::media_ -- --nocapture`：地址/跳转校验、下载输出、取消与音轨验证；真实网络测试保持忽略 |
| `checks` | `pnpm exec tsc --noEmit`（desktop）及 `git diff --check` |
| `real-qwen` | 显式执行已有忽略测试 `qwen::transcription::tests::real_model_transcribes_media`，使用本地官方模型与音视频样本 |

任一步骤失败时脚本返回其非零退出码并停止，不会将跳过或失败当作通过。缺少工具、缺少真实模型测试路径等前提错误返回 2。单条命令默认最长 1800 秒，可用 `--timeout 600` 调整；超时返回 124。`--offline` 仅影响 Cargo，依赖未缓存时会失败，不会自动安装或升级依赖。

`checks` 中差异检查包含当前整个工作区；若有其他未提交编辑的空白错误，会一起报告。脚本不会为通过检查而改文件，也不替代生产构建或原生 App 的实际操作验证。

## 显式真实 Qwen 推理

这是本地算力测试，会校验约 4.7 GB 官方权重并真实推理。先准备中文 WAV/MP4；如果验证的是下载后的媒体，将下载结果作为 `VIBE_QWEN_TEST_AUDIO`。可添加 `VIBE_QWEN_TEST_EXPECT` 检查预期文字片段。

```sh
export VIBE_QWEN_TEST_MODEL_DIR='/绝对路径/Qwen3-ASR-1.7B'
export VIBE_QWEN_TEST_BINARY='/绝对路径/qwen-asr'
export VIBE_QWEN_TEST_FFMPEG='/绝对路径/ffmpeg'
export VIBE_QWEN_TEST_AUDIO='/绝对路径/中文测试音频.wav'
export VIBE_QWEN_TEST_EXPECT='预期文字片段'
uv run plans/homepage-media-input/homepage-media-input_001.py real-qwen --offline
```

脚本只检查这些显式路径的存在与可执行性，然后调用现有 Rust 测试。路径不作为命令执行；Key 不应出现在上述变量中。测试覆盖模型校验、FFmpeg 解码、原生推理、结果非空、时间范围与完成进度；不表示识别率已达标，也不覆盖真实在线模型账号请求。

## 真实平台与人工验收

逐平台样例及结果见[公共平台链接验收记录](platform-validation.md)。这些网络验收不会随默认脚本自动重复，以免把会变化的平台状态或登录限制混入本地回归结果。

原生 App 需另行检查：文件选择/拖入先暂存、Command+Enter 与中文输入法、模型选择与运行锁、分享失败后输入保留/单项重试/取消、历史记录和播放器。在线文本模型的真实账号联调需要在 App 中配置自己的接口，当前交付尚未使用真实账户完成该项实测。

本轮执行结果以集成验收报告及最终交付说明为准；脚本不内置固定测试数量，后续增加测试不会使说明失真。
