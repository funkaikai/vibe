# Qwen3-ASR-1.7B Real Inference Validation

Date: 2026-10-27T11:23:10.633049+00:00
Platform: macOS-26.6.2-arm64-arm-64bit
Model: `Qwen/Qwen3-ASR-1.7B@7278e1e70fe206f11671096ffdd38061171dd6e5`
All seven official model files passed full SHA256 and size verification.
Native source: `antirez/qwen-asr@924694251d9e0f18e5d86bbd06aa3ab5f870002d`.
Backend: macOS Accelerate / CPU; forced Chinese, eight threads, 20-second segment limit.

## Audio

Result: PASS; elapsed 3.14s (model loading included).

```text
你好，这是一段中文语音转文字的测试。这个应用可以在本地识别音频和视频，所有内容都保存在自己的电脑上。
```

## Video

Result: PASS; elapsed 2.36s (model loading included).

```text
你好，这是一段中文语音转文字的测试。这个应用可以在本地识别音频和视频，所有内容都保存在自己的电脑上。
```

This smoke test checks actual inference and audio/video decoding. It does not establish accuracy on recordings, dialects, noisy speech, or long media.
