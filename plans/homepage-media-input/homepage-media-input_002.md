# 首页实现集成验收

日期：2026-10-28。核心实现与 Apple Silicon 本地 App 打包完成；平台覆盖及真实在线账户调用仍有下列验收缺口。

## 已通过

- `desktop` 下 `pnpm test`：35 个文件、209 项通过。最终仅补充滚动布局后，既有首页 6 项和 TypeScript 再次通过。
- `cargo test -p vibe --offline`：83 项通过，2 项真实网络/模型测试默认忽略；没有失败。
- `cargo fmt --all -- --check`、`git diff --check` 通过。Rust 格式工具仍提示已有 nightly 配置警告。
- `pnpm exec tauri build --bundles app` 成功；Vite 提示既有大资源块警告。最终产物复制到 `outputs/Vibe Qwen.app`，本地 ad-hoc 签名通过 `codesign --verify --deep --strict`。
- 原生 App 实测：缺少在线 API Key 时，链接原文保留，显示配置提示及单项重试；没有绕过在线解析进入下载。
- 原生 App 实测：选择 `homepage-downloaded.m4a` 后只显示待转写附件；提交后 Qwen 成功产生非空文本，播放器可用，历史出现新记录。
- 实际记录 `Documents/Vibe Qwen/File-homepage-downloaded-20261028-120139/transcript.vibe.json` 保存了实际 Qwen 模型路径、`language: zh` 和非空分段；媒体已复制到同一历史项目目录。
- 显式 Qwen Rust 集成测试通过（173.47 秒，包括约 4.7 GB 权重校验）。输入为真实下载产物 `work/fixtures/homepage-downloaded.m4a`；结果包含 JFK 示例完整句子，时间范围与完成进度断言通过。样本为英语，这次仅验证功能链路，不评价中文识别率。
- 使用官方 `yt-dlp_macos 2026.10.26` 完成 YouTube 样例实际下载及内置 FFmpeg 音轨验证；微博样例取得媒体信息。详见 [平台报告](platform-validation.md)。
- 原生启动核对最终首页、中文界面及 Qwen 选择状态；小窗口下发现的底部裁切已修复为独立滚动布局。

## 仍未完成的验收

- 没有使用真实账号调用 DeepSeek 或其他 OpenAI 兼容文本接口。自动测试覆盖请求、格式校验、鉴权失败、超时和取消；原生只实测缺少 Key 的严格阻断行为。用户需在 App 设置中填写自己的连接完成账号联调，无需将 Key 发到聊天。
- B站样例被 HTTP 412 拒绝；小红书样例未取得视频格式；抖音样例要求 Cookie。第一版不导入 Cookie、不登录，未尝试绕过。这三个目标平台不能作为已完成支持验收。
- YouTube 测试使用当前网络代理，只覆盖指定公开视频的原生下载与音轨阶段；微博仅覆盖媒体信息提取。两者都没有在首页通过真实在线模型完成一条平台链接的完整提交流程。
- 本地开发包尚未经过 Apple 公证，保留现有本地分发方式。
- 最终 ad-hoc 重新签名后重启，历史扫描等待 macOS 的 Documents 目录访问确认，侧栏暂显示空。磁盘上的 3 条历史项目及记录都存在，原生 `exists` 返回 true，`read_dir` 持续等待；进程采样停在 `opendir/open`，系统 TCC 日志明确记录签名不匹配后重新发起 `kTCCServiceSystemPolicyDocumentsFolder` 授权提示。界面自动化工具禁止操作系统通知进程，未代用户授予权限。需用户处理 macOS 文件访问提示后再核对历史加载；这是本地开发重新签名后的权限验收缺口，不能记作已通过。

## 交付与复现

[中文使用说明](../../HOMEPAGE.md) · [验证入口](homepage-media-input_001.md) · [逐平台记录](platform-validation.md)。

测试创建了一条名为 `File-homepage-downloaded` 的历史记录，保留作为可检查结果；未删除或改写用户已有转录。
