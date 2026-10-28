# 公共平台链接验收记录

日期：2026-10-28（Asia/Shanghai）

## 方法与范围

先使用本机已安装的 `yt-dlp 2026.07.04`，再使用官方 GitHub Release 的 **`yt-dlp_macos 2026.10.26`** 复测。仅将新版下载到工作目录，未升级全局工具。新版 SHA-256 与官方 `SHA2-256SUMS` 匹配：`0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa`。

官方下载来源：[2026.10.26 Release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26)、[校验文件](https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS)。执行文件为工作区 `work/yt-dlp_macos`，脱敏结构化结果为 `work/platform-validation-2026.10.26.json`。

国内平台和微博样例取自下载器各平台 extractor 的内置 `_TESTS`；YouTube 新版复测改用公开的“Me at the zoo”。未读取浏览器 Cookie、用户下载器配置或登录账号，未尝试绕过平台限制。

执行方式：`--ignore-config --no-cache-dir --no-playlist --no-warnings --skip-download --dump-single-json --socket-timeout 10 --retries 0 --fragment-retries 0`，整体每次最长 45 秒，最多并发 3 项。国内平台先直连，失败后使用 `http://127.0.0.1:7890` 重试一次；YouTube 使用已有代理路径。输出仅保留标题、格式数量、耗时、退出状态与脱敏错误，不保存返回的临时媒体 URL。

下方平台表为**媒体信息提取验收**；YouTube 另完成真实下载与音轨检查，详见后文。格式列表本身不等同于下载或完整转写验收。

## 新版结果（2026.10.26）

| 平台 | 公开样例 | 本次真实结果 | 结论 |
| --- | --- | --- | --- |
| B站 | [BV13x41117TL](https://www.bilibili.com/video/BV13x41117TL) | 直连连接被重置（26.39 秒）；代理 HTTP 412（22.73 秒） | 新版仍未取得格式列表，平台/网络限制尚未解决 |
| 小红书 | [6411cf99000000001300b6d9](https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9) | 直连和代理均为 `No video formats found!`（26.54 / 22.80 秒） | 新版仍未取得视频格式，未确认可下载 |
| YouTube | [jNQXAC9IVRw](https://www.youtube.com/watch?v=jNQXAC9IVRw) | 代理成功（29.79 秒），标题 `Me at the zoo`，返回 25 种格式 | 本样例公开媒体信息解析成功 |
| 抖音 | [6961737553342991651](https://www.douyin.com/video/6961737553342991651) | 直连和代理均明确要求 `Fresh cookies (not necessarily logged in) are needed`（22.45 / 15.80 秒） | 新版仍要求 Cookie，按第一版边界停止；不将 Cookie 要求等同于必须登录 |
| 微博（可选） | [7827771738/N4xlMvjhI](https://weibo.com/7827771738/N4xlMvjhI) | 直连成功（16.89 秒），返回 4 种格式；标题“【睡前消息暑假版第一期：拉泰国一把 对中国有好处】” | 本样例公开媒体信息解析成功 |

## YouTube 实际下载与原生音轨验证

使用官方新版 `yt-dlp_macos 2026.10.26`、App 内置 FFmpeg 和同一公开链接 `https://www.youtube.com/watch?v=jNQXAC9IVRw`，运行新 Rust 下载核心的显式集成测试：

`prepare_media_source → yt-dlp 下载/提取 → FFmpeg 验证可解码音轨`

**结果通过**（13.13 秒），真实进度 0.4% 至 100%。产物 `work/fixtures/homepage-youtube.m4a`：419,619 字节、AAC 音轨、19.012 秒。该路径可交给本地 Qwen 转写流程。本次没有配置或调用在线文本模型，所以它验证的是模型解析之后的原生下载与音轨阶段，不是首页提交到转写的完整流程。

可复现命令（从仓库根目录执行，路径为本次实际工具与输出）：

```sh
VIBE_MEDIA_TEST_URL='https://www.youtube.com/watch?v=jNQXAC9IVRw' \
VIBE_MEDIA_TEST_YTDLP='/Users/fun.ma/Documents/Codex/2026-10-27/app-app-x20/work/yt-dlp_macos' \
VIBE_MEDIA_TEST_FFMPEG='/Users/fun.ma/Documents/Codex/2026-10-27/app-app-x20/outputs/Vibe Qwen.app/Contents/MacOS/ffmpeg' \
VIBE_MEDIA_TEST_OUTPUT='/Users/fun.ma/Documents/Codex/2026-10-27/app-app-x20/work/fixtures/homepage-youtube.m4a' \
cargo test -p vibe downloads_and_verifies_real_public_media --offline -- --ignored --nocapture
```

网络使用现有代理环境变量 `http://127.0.0.1:7890`；没有添加账号、Cookie、用户代理伪装或平台绕过参数。

## 旧版对照（2026.07.04）

| 平台 | 公开样例 | 本次真实结果 | 结论 |
| --- | --- | --- | --- |
| B站 | [BV13x41117TL](https://www.bilibili.com/video/BV13x41117TL) | 直连失败（0.42 秒，连接或解析错误）；代理失败（0.53 秒，HTTP 412） | 平台拒绝或网络环境阻碍，未取得格式列表 |
| 小红书 | [6411cf99000000001300b6d9](https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9) | 直连和代理均失败（0.67 / 0.62 秒）；错误为 `No video formats found!` | 当前样例和已安装下载器未取得视频格式，未确认可下载 |
| YouTube | [BaW_jenozKc](https://www.youtube.com/watch?v=BaW_jenozKc) | 代理失败（1.01 秒）；错误为 `This video is unavailable` | 样例在当前环境不可用，不能据此判断所有 YouTube 视频均不可用 |
| 抖音 | [6961737553342991651](https://www.douyin.com/video/6961737553342991651) | 直连和代理均失败（0.45 / 0.39 秒）；下载器明确要求 fresh cookies | 按第一版不使用 Cookie 的边界停止，未下载 |
| 微博（可选） | [7827771738/N4xlMvjhI](https://weibo.com/7827771738/N4xlMvjhI) | 直连提取成功（1.00 秒，退出码 0），返回 4 种格式；标题“【睡前消息暑假版第一期：拉泰国一把 对中国有好处】” | 本样例公开媒体信息可解析，尚未下载或转写 |

小红书和 YouTube 的错误说明通过追加一次相同受限参数的诊断请求确认，仅为区分“无视频格式”与“样例不可用”，未调整认证、客户端或平台绕过参数。

## 原生直链流程验证

另已使用公开 [Whisper 示例 jfk.wav](https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav) 执行新 Rust 下载核心的显式集成测试：

`prepare_media_source → yt-dlp 下载/提取 → FFmpeg 验证可解码音轨`

该次测试通过，输出 `work/fixtures/homepage-downloaded.m4a`：111,777 字节、AAC 音轨、11 秒。App 内置 FFmpeg 对该已下载文件解码 0.25 秒生成 8,000 字节单声道 16 kHz PCM，验证通过。后续一次重复网络尝试在直连探测阶段失败，说明探测路径存在环境可达性限制；没有将失败记录为成功。

本记录不覆盖在线文本模型的真实账号调用，也不代表五个平台已全部完成下载和转写。当前可以确认原生公共媒体直链与上述 YouTube 样例的实际下载、音轨检查，以及微博样例的媒体信息提取。B站、小红书与抖音仍有明确未解决限制，不能宣称全部可用。

## 自动验证

`cargo test -p vibe cmd::media_ --offline -- --nocapture`：13 项通过，1 项需要显式环境变量的真实网络测试默认忽略。覆盖地址/协议/DNS结果分类、来源链接过滤、进度/标题解析、任务隔离、取消抢先到达、静默子进程取消、长输出排空及真实 FFmpeg 的有效/伪造音频检查。

真实网络测试命令：

```sh
VIBE_MEDIA_TEST_URL='<公共音视频链接>' \
VIBE_MEDIA_TEST_YTDLP='<yt-dlp绝对路径>' \
VIBE_MEDIA_TEST_FFMPEG='<FFmpeg绝对路径>' \
VIBE_MEDIA_TEST_OUTPUT='<验证音频保存路径>' \
cargo test -p vibe downloads_and_verifies_real_public_media --offline -- --ignored --nocapture
```
