# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Run real Qwen3-ASR-1.7B inference against audio and video fixtures."""

import argparse
import datetime
import importlib.util
from pathlib import Path
import platform
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--native", type=Path, default=ROOT / "desktop/src-tauri/binaries/qwen-asr-aarch64-apple-darwin")
    parser.add_argument("--report", type=Path, default=Path(__file__).with_suffix(".md"))
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("download_qwen_model", ROOT / "scripts/download_qwen_model.py")
    download = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(download)
    manifest = download.read_manifest(ROOT / "desktop/src-tauri/resources/qwen3-asr-1.7b.json")
    for entry in manifest["files"]:
        if not download.valid_file(args.model / entry["name"], entry):
            raise ValueError(f"Official model integrity check failed: {entry['name']}")
    results = []
    with tempfile.TemporaryDirectory(prefix="vibe-qwen-smoke-") as temporary:
        for label, fixture in (("Audio", args.audio), ("Video", args.video)):
            normalized = Path(temporary) / f"{label}.wav"
            subprocess.run([
                str(args.ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", str(fixture), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(normalized),
            ], check=True, timeout=60)
            command = [str(args.native), "-d", str(args.model), "-i", str(normalized), "--silent", "--language", "Chinese", "-t", "8", "-S", "20"]
            started = time.monotonic()
            process = subprocess.run(command, capture_output=True, text=True, timeout=600)
            elapsed = time.monotonic() - started
            text = process.stdout.strip()
            success = process.returncode == 0 and len(text) > 10
            results.append((label, elapsed, success, text, process.stderr.strip()))
            print(f"{label}: {'PASS' if success else 'FAIL'} in {elapsed:.2f}s\n{text}", flush=True)
    lines = [
        "# Qwen3-ASR-1.7B Real Inference Validation", "",
        f"Date: {datetime.datetime.now(datetime.timezone.utc).isoformat()}",
        f"Platform: {platform.platform()}",
        f"Model: `{manifest['id']}@{manifest['revision']}`",
        "All seven official model files passed full SHA256 and size verification.",
        "Native source: `antirez/qwen-asr@924694251d9e0f18e5d86bbd06aa3ab5f870002d`.",
        "Backend: macOS Accelerate / CPU; forced Chinese, eight threads, 20-second segment limit.", "",
    ]
    for label, elapsed, success, text, error in results:
        lines.extend([f"## {label}", "", f"Result: {'PASS' if success else 'FAIL'}; elapsed {elapsed:.2f}s (model loading included).", "", "```text", text, "```", ""])
        if error:
            lines.extend(["Diagnostics:", "", "```text", error, "```", ""])
    lines.extend(["This smoke test checks actual inference and audio/video decoding. It does not establish accuracy on recordings, dialects, noisy speech, or long media.", ""])
    args.report.write_text("\n".join(lines))
    raise SystemExit(0 if all(result[2] for result in results) else 1)


if __name__ == "__main__":
    main()
