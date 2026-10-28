# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Run repository checks for the unified media homepage without accessing API credentials."""

import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
FRONTEND_TESTS = [
    "src/lib/media-input.test.ts",
    "src/lib/ai/ai.test.ts",
    "src/lib/ai/presets.test.ts",
    "src/pages/settings/sections/ai.test.tsx",
    "src/pages/main/hooks/use-media-composer.test.ts",
    "src/pages/main/components/idle-hero.test.tsx",
    "src/pages/main/components/media-model-picker.test.tsx",
    "src/pages/main/page.test.tsx",
    "src/lib/transcripts-store.test.ts",
]
QWEN_TEST = "qwen::transcription::tests::real_model_transcribes_media"
QWEN_PATHS = {
    "VIBE_QWEN_TEST_MODEL_DIR": "directory",
    "VIBE_QWEN_TEST_BINARY": "executable",
    "VIBE_QWEN_TEST_FFMPEG": "executable",
    "VIBE_QWEN_TEST_AUDIO": "file",
}


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise ValueError(f"缺少命令 {name}，请先安装并加入 PATH。")
    return found


def run(command: list[str], directory: Path, timeout: int) -> int:
    # Lists go directly to subprocess: no shell, evaluation or command interpolation.
    print(f"\n[{directory.relative_to(ROOT) or '.'}] {shlex.join(command)}", flush=True)
    try:
        completed = subprocess.run(command, cwd=directory, timeout=timeout, check=False)
        return completed.returncode if completed.returncode >= 0 else 1
    except subprocess.TimeoutExpired:
        print(f"验证超时（{timeout} 秒），请检查该步骤输出。", file=sys.stderr)
        return 124
    except OSError as cause:
        print(f"无法启动验证：{cause.strerror or type(cause).__name__}", file=sys.stderr)
        return 1


def validate_qwen_environment() -> None:
    for variable, kind in QWEN_PATHS.items():
        value = os.environ.get(variable, "")
        if not value:
            raise ValueError(f"real-qwen 需要显式配置 {variable}。")
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise ValueError(f"{variable} 必须使用绝对路径。")
        if kind == "directory" and not path.is_dir():
            raise ValueError(f"{variable} 必须指向已存在的模型目录。")
        if kind != "directory" and (not path.is_file() or path.stat().st_size == 0):
            raise ValueError(f"{variable} 必须指向非空文件。")
        if kind == "executable" and not os.access(path, os.X_OK):
            raise ValueError(f"{variable} 指向的文件不可执行。")
        # The Rust ignored test reads the original environment; normalize ~ there too.
        os.environ[variable] = str(path)


def commands_for(group: str, offline: bool) -> list[tuple[list[str], Path]]:
    if group == "frontend":
        return [([executable("pnpm"), "test", *FRONTEND_TESTS], ROOT / "desktop")]
    if group == "checks":
        return [
            ([executable("pnpm"), "exec", "tsc", "--noEmit"], ROOT / "desktop"),
            ([executable("git"), "diff", "--check"], ROOT),
        ]
    rust = [executable("cargo"), "test", "-p", "vibe"]
    if group == "rust":
        rust.append("cmd::media_")
    elif group == "real-qwen":
        validate_qwen_environment()
        rust.append(QWEN_TEST)
    else:
        raise ValueError(f"未知验证组：{group}")
    if offline:
        rust.append("--offline")
    rust += ["--", "--nocapture"]
    if group == "real-qwen":
        rust += ["--ignored", "--exact"]
    return [(rust, ROOT)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "groups", nargs="*", choices=["frontend", "rust", "checks", "real-qwen"],
        help="默认 frontend rust checks；real-qwen 只在显式指定时运行。",
    )
    parser.add_argument("--offline", action="store_true", help="Cargo 使用已有本地依赖，不访问包索引。")
    parser.add_argument("--timeout", type=int, default=1800, help="每条命令的超时秒数，默认 1800。")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout 必须为正整数。")
    if not (ROOT / "desktop/package.json").is_file():
        parser.error("无法从脚本位置找到 Vibe 仓库。")
    groups = list(dict.fromkeys(args.groups or ["frontend", "rust", "checks"]))
    try:
        # Validate all prerequisites before running any group.
        commands = [step for group in groups for step in commands_for(group, args.offline)]
    except (ValueError, OSError) as cause:
        parser.error(str(cause))
    for command, directory in commands:
        status = run(command, directory, args.timeout)
        if status:
            print(f"验证失败，退出码 {status}；后续步骤未执行。", file=sys.stderr)
            return status
    print("\n所选验证组全部通过。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
