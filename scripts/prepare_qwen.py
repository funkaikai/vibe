# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the pinned Qwen3-ASR native sidecar for macOS Apple Silicon."""

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
REVISION = "924694251d9e0f18e5d86bbd06aa3ab5f870002d"
ARCHIVE_SHA256 = "c197e4381a14019f254b910260fdbae08ea28fdfb7ec3003dbf22560f37f839f"
SOURCE_URL = f"https://codeload.github.com/antirez/qwen-asr/tar.gz/{REVISION}"
SOURCE_FILES = (
    "main.c", "qwen_asr.c", "qwen_asr_kernels.c", "qwen_asr_kernels_generic.c",
    "qwen_asr_kernels_neon.c", "qwen_asr_kernels_avx.c", "qwen_asr_audio.c",
    "qwen_asr_encoder.c", "qwen_asr_decoder.c", "qwen_asr_tokenizer.c",
    "qwen_asr_safetensors.c",
)
HEADER_FILES = (
    "qwen_asr.h", "qwen_asr_kernels.h", "qwen_asr_kernels_impl.h",
    "qwen_asr_audio.h", "qwen_asr_tokenizer.h", "qwen_asr_safetensors.h",
)
ALLOWED_FILES = frozenset((*SOURCE_FILES, *HEADER_FILES, "LICENSE"))


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def extract_sources(archive: Path, destination: Path) -> None:
    if sha256(archive) != ARCHIVE_SHA256:
        raise ValueError("Qwen source archive SHA256 does not match the pinned revision")
    found = set()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            if len(parts) != 2 or parts[0] != f"qwen-asr-{REVISION}":
                continue
            filename = parts[1]
            if filename not in ALLOWED_FILES:
                continue
            if not member.isfile() or member.size > 4 * 1024 * 1024 or filename in found:
                raise ValueError(f"Unsafe source archive entry: {member.name}")
            content = source.extractfile(member)
            if content is None:
                raise ValueError(f"Missing archive content: {filename}")
            with content, (destination / filename).open("xb") as target:
                shutil.copyfileobj(content, target)
            found.add(filename)
    if found != ALLOWED_FILES:
        raise ValueError(f"Incomplete source archive: {sorted(ALLOWED_FILES - found)}")


def download_archive(destination: Path, proxy: str | None) -> None:
    handlers = [urllib.request.ProxyHandler({"https": proxy, "http": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "vibe-qwen-build/1"})
    with opener.open(request, timeout=60) as response, destination.open("xb") as target:
        downloaded = 0
        while block := response.read(1024 * 1024):
            downloaded += len(block)
            if downloaded > 32 * 1024 * 1024:
                raise ValueError("Qwen source archive exceeds the 32 MiB limit")
            target.write(block)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "desktop/src-tauri/binaries/qwen-asr-aarch64-apple-darwin")
    parser.add_argument("--archive", type=Path, help="Use a local archive; the pinned SHA256 is still checked")
    parser.add_argument("--proxy", help="Optional HTTP proxy, for example http://127.0.0.1:7890")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() not in ("arm64", "aarch64"):
        parser.error("The Qwen sidecar currently supports macOS Apple Silicon only")
    if not shutil.which("xcrun"):
        parser.error("Install Xcode Command Line Tools before building the Qwen sidecar")
    output = args.output.expanduser().absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink():
        parser.error("Refusing to replace a symlink at the sidecar output path")
    with tempfile.TemporaryDirectory(prefix="vibe-qwen-build-") as temporary:
        working = Path(temporary)
        archive = args.archive or working / "source.tar.gz"
        if args.archive is None:
            print(f"Downloading pinned Qwen native source: {REVISION}", flush=True)
            download_archive(archive, args.proxy)
        source = working / "source"
        source.mkdir()
        extract_sources(archive, source)
        binary = working / output.name
        command = [
            "xcrun", "clang", "-arch", "arm64", "-mmacosx-version-min=13.3",
            "-O3", "-ffast-math", "-Wall", "-Wextra", "-DUSE_BLAS",
            "-DACCELERATE_NEW_LAPACK", "-Wl,-no_uuid", "-o", str(binary),
            *SOURCE_FILES, "-lm", "-lpthread", "-framework", "Accelerate",
        ]
        subprocess.run(command, cwd=source, check=True, timeout=300)
        subprocess.run([str(binary), "--list-languages"], check=True, timeout=10)
        installed_license = ROOT / "desktop/src-tauri/resources/qwen-asr-LICENSE"
        if not installed_license.exists() or installed_license.read_bytes() != (source / "LICENSE").read_bytes():
            raise ValueError("Bundled qwen-asr-LICENSE does not match the pinned native source")
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".qwen-asr-", delete=False) as target:
            staged = Path(target.name)
            with binary.open("rb") as built:
                shutil.copyfileobj(built, target)
        try:
            staged.chmod(0o755)
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)
    print(f"Prepared {output}\nSHA256: {sha256(output)}")


if __name__ == "__main__":
    main()
