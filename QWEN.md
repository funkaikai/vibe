# Vibe Qwen

本 fork 的第一步是在 macOS 13.3 及以上的 Apple Silicon 上接入 [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)。使用原始官方 BF16 权重，完全在本机运行，不需要 API Key。

## 使用

1. 打开 `Vibe Qwen.app`，进入「设置 > 模型」。
2. 点击 Qwen3-ASR-1.7B 右侧下载图标。约需 4.7 GB 磁盘空间；下载后自动选择。
3. 导入音频或视频，开始转写。也可在模型下拉框切回已有 Whisper 模型。
4. 若文件损坏，使用 Qwen 行的「校验并修复」。取消下载后重试会复用已经完整校验的文件。

App 名称为 `Vibe Qwen`，标识符为 `com.funkaikai.vibe-qwen`，项目目录为 `Documents/Vibe Qwen`。它使用独立配置、模型目录和 `vibe-qwen://` 协议；不会从上游渠道自动更新。已有官方 Vibe 不受替换。

## 当前范围

- 本地音频、视频以及 Vibe 下载后的媒体文件转写，默认中文；可选自动语言识别。
- 原生引擎为 [antirez/qwen-asr](https://github.com/antirez/qwen-asr)，固定提交 `924694251d9e0f18e5d86bbd06aa3ab5f870002d`，使用 Accelerate / CPU，暂不使用 Apple GPU。
- 每段输入最多 20 秒，结果中的时间范围表示输入分段边界。字幕可以导出，但不是词级或句级精确对齐；分段边界附近的语音可能影响识别效果。
- Qwen 暂不支持翻译、说话人分离、Whisper 解码参数、精确时间戳、手机接力及 HTTP API。Whisper 仍使用原有后端。
- 交付的本地开发包使用 ad-hoc 签名，未进行 Developer ID 签名或公证，不作为公开分发安装包。

## 本地构建

前提：macOS Apple Silicon、Xcode Command Line Tools、Rust、Node.js、pnpm、uv，以及上游使用的 chore >= 1.6.0。

```sh
chore setup
cd desktop
pnpm install --frozen-lockfile
pnpm exec tauri build --bundles app
cd ..
codesign --force --deep --sign - --entitlements desktop/src-tauri/entitlements.plist 'target/release/bundle/macos/Vibe Qwen.app'
```

`chore setup` 会准备上游 FFmpeg / vibe-server 及额外的原生 Qwen 程序。也可单独运行 `uv run scripts/prepare_qwen.py`；如果需要代理，添加 `--proxy http://127.0.0.1:7890`。原生源码下载使用固定 SHA256，打包时包含其 MIT 许可证。Python 仅用于构建，不随 App 运行。

上游 `upgrade` 自动替换官方 App 的任务在本 fork 中已禁用。构建结果位于 `target/release/bundle/macos/Vibe Qwen.app`。

## 权重版本

固定官方版本 `7278e1e70fe206f11671096ffdd38061171dd6e5`。文件清单、大小和 SHA256 位于 `desktop/src-tauri/resources/qwen3-asr-1.7b.json`，不接受其他 checkpoint 冒充此模型。加载前会完整检查所有文件。

网络较慢时可以用开发工具提前下载，再把完整的 `Qwen3-ASR-1.7B` 目录放入设置页的模型文件夹：

```sh
uv run scripts/download_qwen_model.py --output /path/to/models/Qwen3-ASR-1.7B
```

开发下载器也支持显式指定官方 ModelScope 同名模型源，最终仍必须匹配全部固定 SHA256：

```sh
uv run scripts/download_qwen_model.py \
  --output /path/to/models/Qwen3-ASR-1.7B \
  --base-url https://modelscope.cn/models/Qwen/Qwen3-ASR-1.7B/resolve/master \
  --no-proxy
```

## 验证

```sh
cd desktop
pnpm test
pnpm build
cd ..
cargo test -p vibe
uv run plans/qwen3-asr/qwen3-asr_001.py
```

工具测试说明位于 `plans/qwen3-asr/qwen3-asr_001.md`，真实权重推理结果位于 `plans/qwen3-asr/qwen3-asr_002.md`，桌面集成验收记录位于 `plans/qwen3-asr/qwen3-asr_003.md`。

已在 Apple Silicon Mac 上完成官方权重校验、中文 WAV / MP4 的真实推理及 App 内转写。这些短中文合成语音样例用于验证接入，不代表真实录音、方言或嘈杂环境的识别率，也不能据此断言优于 Whisper。
