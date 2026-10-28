# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate Qwen download integrity, safe source extraction, and byte-range resume."""

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest
import urllib.request
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


download = load_module("download_qwen_model")
prepare = load_module("prepare_qwen")


class Response(io.BytesIO):
    def __init__(self, content: bytes, status=200, headers=None):
        super().__init__(content)
        self.status = status
        self.headers = headers or {}


class Opener:
    def __init__(self, content: bytes, honor_range=True, wrong_range=False):
        self.content = content
        self.honor_range = honor_range
        self.wrong_range = wrong_range
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        requested = request.get_header("Range")
        if requested and self.honor_range:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested)
            start = int(match[1])
            end = int(match[2]) if match[2] else len(self.content) - 1
            header_start = start + 1 if self.wrong_range else start
            return Response(self.content[start:end + 1], 206, {"Content-Range": f"bytes {header_start}-{end}/{len(self.content)}"})
        return Response(self.content)


class QwenToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.content = b"verified original Qwen model fixture"
        self.entry = {"name": "vocab.json", "size": len(self.content), "sha256": hashlib.sha256(self.content).hexdigest()}

    def tearDown(self):
        self.temporary.cleanup()

    def test_manifest_pins_identity_and_flat_file_set(self):
        original = ROOT / "desktop/src-tauri/resources/qwen3-asr-1.7b.json"
        manifest = download.read_manifest(original)
        altered = self.folder / "manifest.json"
        for field, value in (("id", "Other/Model"), ("revision", "main")):
            with self.subTest(field=field):
                changed = {**manifest, field: value}
                altered.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    download.read_manifest(altered)
        manifest["files"][0]["name"] = "../../outside.json"
        altered.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            download.read_manifest(altered)

    def test_verified_download_needs_no_network(self):
        destination = self.folder / self.entry["name"]
        destination.write_bytes(self.content)
        opener = Opener(b"unexpected")
        download.download_file(opener, self.folder, self.entry, 1)
        self.assertEqual(opener.requests, [])
        self.assertEqual(destination.read_bytes(), self.content)

    def test_partial_download_resumes_from_existing_prefix(self):
        partial = self.folder / (self.entry["name"] + ".part")
        partial.write_bytes(self.content[:9])
        opener = Opener(self.content)
        download.download_file(opener, self.folder, self.entry, 1)
        self.assertEqual(opener.requests[0].get_header("Range"), "bytes=9-")
        self.assertEqual((self.folder / self.entry["name"]).read_bytes(), self.content)
        self.assertFalse(partial.exists())

    def test_server_ignoring_range_restarts_instead_of_appending(self):
        (self.folder / (self.entry["name"] + ".part")).write_bytes(b"wrong prefix")
        download.download_file(Opener(self.content, honor_range=False), self.folder, self.entry, 1)
        self.assertEqual((self.folder / self.entry["name"]).read_bytes(), self.content)

    def test_corrupt_response_does_not_replace_existing_model(self):
        destination = self.folder / self.entry["name"]
        destination.write_bytes(b"previous model")
        with self.assertRaises(ValueError):
            download.download_file(Opener(b"X" * len(self.content)), self.folder, self.entry, 1)
        self.assertEqual(destination.read_bytes(), b"previous model")
        self.assertFalse((self.folder / (self.entry["name"] + ".part")).exists())

    def test_symlink_destination_is_rejected(self):
        outside = self.folder / "outside"
        outside.write_bytes(b"untouched")
        (self.folder / self.entry["name"]).symlink_to(outside)
        with self.assertRaises(ValueError):
            download.download_file(Opener(self.content), self.folder, self.entry, 1)
        self.assertEqual(outside.read_bytes(), b"untouched")

    def test_parallel_ranges_preserve_existing_prefix(self):
        partial = self.folder / "weights.part"
        partial.write_bytes(self.content[:7])
        self.assertTrue(download.download_ranges(Opener(self.content), "https://example.invalid/model", partial, len(self.content), 2))
        self.assertEqual(partial.read_bytes(), self.content)

    def test_incorrect_content_range_is_rejected(self):
        partial = self.folder / "weights.part"
        with self.assertRaises(ValueError):
            download.download_ranges(Opener(self.content, wrong_range=True), "https://example.invalid/model", partial, len(self.content), 2)
        self.assertFalse(partial.exists())

    def test_multiple_ranges_are_assembled_in_byte_order(self):
        content = b"x" * (16 * 1024 * 1024) + b"last range"
        partial = self.folder / "weights.part"
        download.download_ranges(Opener(content), "https://example.invalid/model", partial, len(content), 2)
        self.assertEqual(partial.read_bytes(), content)

    def test_curl_handles_redirect_headers_and_preserves_range(self):
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            Path(command[command.index("--output") + 1]).write_bytes(b"v")
            Path(command[command.index("--dump-header") + 1]).write_bytes(
                b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/final\r\n\r\n"
                b"HTTP/2 206\r\nContent-Range: bytes 0-0/36\r\n\r\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout=b"206", stderr=b"")

        request = urllib.request.Request("https://example.invalid/model", headers={"Range": "bytes=0-0"})
        with patch.object(download.subprocess, "run", run):
            with download.CurlOpener(None, True).open(request, 10) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers["Content-Range"], "bytes 0-0/36")
                self.assertEqual(response.read(), b"v")
        self.assertIn("Range: bytes=0-0", commands[0])
        self.assertIn("--noproxy", commands[0])

    def test_curl_failure_does_not_expose_proxy_credentials(self):
        failure = subprocess.CalledProcessError(22, ["curl", "--proxy", "http://private-password@example.invalid"])
        request = urllib.request.Request("https://example.invalid/model")
        with patch.object(download.subprocess, "run", side_effect=failure):
            with self.assertRaises(OSError) as result:
                download.CurlOpener(None, True).open(request, 10)
        self.assertNotIn("private-password", str(result.exception))

    def test_source_archive_requires_pinned_hash(self):
        archive = self.folder / "archive.tar.gz"
        archive.write_bytes(b"untrusted archive")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            prepare.extract_sources(archive, self.folder)

    def test_selected_source_cannot_be_an_archive_symlink(self):
        archive = self.folder / "archive.tar.gz"
        with tarfile.open(archive, "w:gz") as target:
            member = tarfile.TarInfo(f"qwen-asr-{prepare.REVISION}/main.c")
            member.type = tarfile.SYMTYPE
            member.linkname = "../../outside"
            target.addfile(member)
        with patch.object(prepare, "ARCHIVE_SHA256", prepare.sha256(archive)):
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                prepare.extract_sources(archive, self.folder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(QwenToolTests))
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
