# Qwen Native Build and Download Validation

Validation on 2026-10-27: 13 tests passed. Two builds from independent temporary
directories produced identical native binary SHA256:
`bd136e48952894ff655a4ea549bc1096fc08034fcd272d67dc1e3fe37d6dfe4a`.
Toolchain: Apple clang 16.0.0 (clang-1600.0.26.6), macOS SDK 15.2.

Run from the repository root:

```sh
uv run plans/qwen3-asr/qwen3-asr_001.py
uv run scripts/prepare_qwen.py
uv run scripts/download_qwen_model.py --output /path/to/Qwen3-ASR-1.7B
uv run scripts/download_qwen_model.py --output /path/to/Qwen3-ASR-1.7B --verify-only
```

The standalone validation script covers pinned model identity, flat file allowlists,
source archive integrity, source symlink rejection, verified-file reuse, interrupted
download resume, servers ignoring Range, exact Content-Range checks, corruption,
symlink destinations, HTTP redirect header parsing, and proxy credential
redaction. It does not download model weights.

The build script requires macOS Apple Silicon and Xcode Command Line Tools. It
downloads a pinned source archive and verifies SHA256 before extracting a fixed
allowlist of C sources, headers, and the license. It invokes clang directly using
arm64 instructions and the system Accelerate framework, targeting macOS 13.3 or
newer. The source and compiler
flags are fixed; binary reproducibility additionally depends on using the same
Xcode/SDK toolchain. The App bundles this native binary, with no Python runtime.

The download script accepts an explicit `--proxy http://127.0.0.1:7890` when needed.
Large files use four verified byte-range connections by default; `--connections 16`
can improve slow downloads, and `--connections 1` selects sequential transfer.
The default transport is the macOS system curl HTTP/2 client; `--transport urllib`
is an alternative when curl is unavailable. Neither needs third-party Python packages.
Each range must return HTTP 206 with the exact requested Content-Range and byte
count. All files undergo final full SHA256 and size checks before atomic publication.
Interrupted prefixes remain in `.part` files for retry. Existing verified files
are reused. Model weights are downloaded from the specified official revision.

Explicit alternative hosting is available when HF is slow: pass
`--base-url https://modelscope.cn/models/Qwen/Qwen3-ASR-1.7B/resolve/master --no-proxy`.
This accepts only the identical weights and files: every SHA256 must still match
the pinned Hugging Face revision. HF remains the default source. A pinned
`https://hf-mirror.com/Qwen/Qwen3-ASR-1.7B/resolve/7278e1e70fe206f11671096ffdd38061171dd6e5`
base URL is also supported explicitly. No substitute checkpoint is accepted.

Real model smoke validation, after downloading the weights:

```sh
uv run plans/qwen3-asr/qwen3-asr_002.py \
  --model /path/to/Qwen3-ASR-1.7B \
  --audio /path/to/chinese.wav \
  --video /path/to/chinese.mp4 \
  --ffmpeg /path/to/ffmpeg
```

The smoke runner verifies all weights, decodes both inputs with FFmpeg, runs the
native 1.7B model in Chinese, and writes `qwen3-asr_002.md` with actual output,
elapsed time, and diagnostics. Native CLI validation does not replace desktop
integration verification or a recognition-quality comparison on real recordings.
