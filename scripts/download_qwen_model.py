# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Download and verify the pinned official Qwen3-ASR-1.7B model."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesHeaderParser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "Qwen/Qwen3-ASR-1.7B"
REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5"
DEFAULT_BASE_URL = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}"
ALLOWED_BASE_URLS = frozenset((
    DEFAULT_BASE_URL,
    f"https://hf-mirror.com/{MODEL_ID}/resolve/{REVISION}",
    f"https://modelscope.cn/models/{MODEL_ID}/resolve/master",
))
ALLOWED_FILES = frozenset((
    "config.json", "generation_config.json", "model.safetensors.index.json",
    "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors",
    "vocab.json", "merges.txt",
))


class CurlResponse:
    def __init__(self, temporary, status: int, headers):
        self.temporary = temporary
        self.status = status
        self.headers = headers
        self.source = (Path(temporary.name) / "body").open("rb")

    def read(self, size=-1):
        return self.source.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.source.close()
        self.temporary.cleanup()


class CurlOpener:
    """Use the macOS system HTTP/2 client without adding Python dependencies."""

    def __init__(self, proxy: str | None, direct: bool):
        self.proxy = proxy
        self.direct = direct

    def open(self, request, timeout):
        temporary = tempfile.TemporaryDirectory(prefix="vibe-qwen-http-")
        folder = Path(temporary.name)
        command = [
            "curl", "-q", "--fail", "--location", "--http2", "--silent", "--show-error",
            "--connect-timeout", "15", "--max-time", str(timeout),
            "--output", str(folder / "body"), "--dump-header", str(folder / "headers"),
            "--write-out", "%{http_code}",
        ]
        if self.direct:
            command.extend(["--noproxy", "*"])
        elif self.proxy:
            command.extend(["--proxy", self.proxy])
        requested = request.get_header("Range")
        maximum = 6 * 1024**3
        if requested:
            command.extend(["--header", f"Range: {requested}"])
            match = re.fullmatch(r"bytes=(\d+)-(\d+)", requested)
            if match:
                maximum = int(match[2]) - int(match[1]) + 1
        # Redirect responses can carry a small HTML body before the requested range.
        command.extend(["--max-filesize", str(max(maximum, 1024 * 1024)), request.full_url])
        try:
            result = subprocess.run(command, capture_output=True, check=True, timeout=timeout + 15)
            blocks = (folder / "headers").read_bytes().split(b"\r\n\r\n")
            response_headers = [block.split(b"\r\n", 1)[1] for block in blocks if block.startswith(b"HTTP/") and b"\r\n" in block]
            if not response_headers:
                raise OSError("curl returned no HTTP response headers")
            headers = BytesHeaderParser().parsebytes(response_headers[-1])
            return CurlResponse(temporary, int(result.stdout), headers)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            temporary.cleanup()
            detail = f"curl exit {error.returncode}" if isinstance(error, subprocess.CalledProcessError) else type(error).__name__
            raise OSError(f"HTTP/2 model download failed ({detail})") from None


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def read_manifest(path: Path) -> dict:
    if path.stat().st_size > 64 * 1024:
        raise ValueError("Model manifest exceeds 64 KiB")
    manifest = json.loads(path.read_text())
    if manifest.get("id") != MODEL_ID or manifest.get("revision") != REVISION:
        raise ValueError("Model manifest does not describe the pinned Qwen3-ASR-1.7B revision")
    entries = manifest.get("files", [])
    names = [entry.get("name") for entry in entries]
    if len(names) != len(ALLOWED_FILES) or set(names) != ALLOWED_FILES:
        raise ValueError("Model manifest must contain exactly the official Qwen3-ASR-1.7B file set")
    for entry in entries:
        if type(entry.get("size")) is not int or not 0 < entry["size"] < 6 * 1024**3:
            raise ValueError(f"Invalid model file size: {entry['name']}")
        if not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256", ""))):
            raise ValueError(f"Invalid model file SHA256: {entry['name']}")
    return manifest


def valid_file(path: Path, entry: dict) -> bool:
    return path.is_file() and path.stat().st_size == entry["size"] and sha256(path) == entry["sha256"]


def download_ranges(opener, url: str, partial: Path, size: int, connections: int) -> bool:
    offset = partial.stat().st_size if partial.exists() else 0
    probe = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{offset}", "Accept-Encoding": "identity"})
    with opener.open(probe, timeout=90) as response:
        if response.status != 206:
            return False
        if response.headers.get("Content-Range") != f"bytes {offset}-{offset}/{size}" or len(response.read(2)) != 1:
            raise ValueError("Server did not honor the exact probe byte range")

    def fetch_range(start: int, end: int, destination: Path) -> Path:
        request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"})
        with opener.open(request, timeout=90) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
                raise ValueError("Server did not honor an exact download byte range")
            received = 0
            with destination.open("xb") as target:
                while block := response.read(4 * 1024 * 1024):
                    received += len(block)
                    if received > end - start + 1:
                        raise ValueError("Range download exceeded its requested byte count")
                    target.write(block)
            if received != end - start + 1:
                raise ValueError("Range download ended before its requested byte count")
        return destination

    chunk_size = 4 * 1024 * 1024
    with tempfile.TemporaryDirectory(prefix=".qwen-ranges-", dir=partial.parent) as temporary:
        with ThreadPoolExecutor(max_workers=connections) as executor:
            while offset < size:
                starts = range(offset, min(offset + connections * chunk_size, size), chunk_size)
                futures = [executor.submit(fetch_range, start, min(start + chunk_size, size) - 1, Path(temporary) / str(start)) for start in starts]
                fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "ab") as target:
                    for future in futures:
                        downloaded = future.result()
                        with downloaded.open("rb") as source:
                            shutil.copyfileobj(source, target)
                        offset += downloaded.stat().st_size
                        downloaded.unlink()
                print(f"  {partial.name.removesuffix('.part')}: {offset / size:.1%}", flush=True)
    return True


def download_file(opener, output: Path, entry: dict, attempts: int, connections: int = 1, base_url: str = DEFAULT_BASE_URL) -> None:
    destination = output / entry["name"]
    partial = destination.with_name(destination.name + ".part")
    if destination.is_symlink() or partial.is_symlink():
        raise ValueError(f"Refusing symlink model path: {entry['name']}")
    if valid_file(destination, entry):
        print(f"[verified] {entry['name']}", flush=True)
        return
    url = f"{base_url}/{entry['name']}"
    for attempt in range(attempts):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > entry["size"]:
                partial.unlink()
                offset = 0
            if offset < entry["size"] and connections > 1 and entry["size"] > 32 * 1024 * 1024:
                print(f"[download] {entry['name']} ({connections} connections, {offset}/{entry['size']} bytes)", flush=True)
                if download_ranges(opener, url, partial, entry["size"], connections):
                    offset = entry["size"]
            if offset != entry["size"]:
                headers = {"User-Agent": "vibe-qwen-model/1"}
                if offset:
                    headers["Range"] = f"bytes={offset}-"
                request = urllib.request.Request(url, headers=headers)
                with opener.open(request, timeout=90) as response:
                    resumed = response.status == 206
                    if resumed and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                        raise ValueError("Download returned an unexpected Content-Range")
                    if not resumed:
                        offset = 0
                    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if resumed else os.O_TRUNC)
                    fd = os.open(partial, flags, 0o600)
                    downloaded = offset
                    last_report = time.monotonic()
                    print(f"[download] {entry['name']} ({offset}/{entry['size']} bytes)", flush=True)
                    with os.fdopen(fd, "wb") as target:
                        while block := response.read(4 * 1024 * 1024):
                            downloaded += len(block)
                            if downloaded > entry["size"]:
                                raise ValueError("Download exceeds the manifest file size")
                            target.write(block)
                            if time.monotonic() - last_report > 15:
                                print(f"  {entry['name']}: {downloaded / entry['size']:.1%}", flush=True)
                                last_report = time.monotonic()
            if not valid_file(partial, entry):
                partial.unlink(missing_ok=True)
                raise ValueError(f"Model integrity check failed: {entry['name']}")
            os.replace(partial, destination)
            print(f"[verified] {entry['name']}", flush=True)
            return
        except (OSError, ValueError) as error:
            if attempt + 1 == attempts:
                raise
            print(f"[retry {attempt + 1}/{attempts}] {entry['name']}: {error}", flush=True)
            time.sleep(min(2 ** attempt, 10))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Destination directory for official model files")
    parser.add_argument("--manifest", type=Path, default=ROOT / "desktop/src-tauri/resources/qwen3-asr-1.7b.json")
    proxy = parser.add_mutually_exclusive_group()
    proxy.add_argument("--proxy", help="Optional HTTP proxy, for example http://127.0.0.1:7890")
    proxy.add_argument("--no-proxy", action="store_true", help="Connect directly instead of using environment proxy settings")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Explicit official ModelScope or pinned HF mirror base URL; original HF SHA256 checks remain mandatory")
    parser.add_argument("--attempts", type=int, default=4, help="Maximum attempts per file (default: 4)")
    parser.add_argument("--connections", type=int, default=4, help="Verified concurrent byte ranges for large files (1-16, default: 4)")
    parser.add_argument("--transport", choices=("curl", "urllib"), default="curl", help="HTTP client (default: system curl with HTTP/2)")
    parser.add_argument("--verify-only", action="store_true", help="Check existing files without downloading")
    args = parser.parse_args()
    if not 1 <= args.attempts <= 10:
        parser.error("--attempts must be between 1 and 10")
    if not 1 <= args.connections <= 16:
        parser.error("--connections must be between 1 and 16")
    args.base_url = args.base_url.rstrip("/")
    if args.base_url not in ALLOWED_BASE_URLS:
        parser.error("--base-url must point to the official Qwen3-ASR-1.7B HF revision, its HF mirror, or official ModelScope hosting")
    manifest = read_manifest(args.manifest)
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.transport == "curl":
        if not shutil.which("curl"):
            parser.error("curl is unavailable; install it or use --transport urllib")
        opener = CurlOpener(args.proxy, args.no_proxy)
    else:
        handlers = [urllib.request.ProxyHandler({})] if args.no_proxy else ([urllib.request.ProxyHandler({"https": args.proxy, "http": args.proxy})] if args.proxy else [])
        opener = urllib.request.build_opener(*handlers)
    for entry in manifest["files"]:
        if args.verify_only:
            destination = output / entry["name"]
            if destination.is_symlink() or not valid_file(destination, entry):
                raise ValueError(f"Missing or invalid model file: {entry['name']}")
            print(f"[verified] {entry['name']}", flush=True)
        else:
            download_file(opener, output, entry, args.attempts, args.connections, args.base_url)
    print(f"Verified {MODEL_ID}@{REVISION}: {output}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
