# 中文产品说明与导航迁移实施计划

> 按用户已确认的范围在当前会话执行；分工互不覆盖，协调者负责共享导航配置和最终验证。

**目标：** README 与 App 可见导航归属当前产品，不再误导至上游服务。

**方案：** 复用现有 Tauri/React 导航与剪贴板能力，新增当前产品的中文隐私与反馈文档。所有产品导航集中使用当前仓库分支，手机配对要求显式配置自有网页。

**技术栈：** Markdown、TypeScript/React、Rust/Tauri、Vitest。

## 约束

- 当前产品名 Vibe Qwen；当前仓库 funkaikai/vibe，分支 fork/macos-baseline。
- 不创建官网、社群、发行版本或开启 Issues，不添加依赖，不替换实际运行所需的第三方资源地址。
- 保留 LICENSE；不在反馈 URL 中发送诊断；保留手机既有配对数据。

## 任务

- [x] 文档：重写 README.md，新增 docs/PRIVACY.md、docs/FEEDBACK.md；检查中文、功能范围与本地链接。
- [x] 产品导航：更新 desktop/src/lib/config.ts 与 settings/sections/general.tsx；版本入口使用当前功能说明，模型帮助及隐私使用自有文档。
- [x] 反馈：更新 lib/app.ts、settings/view-model.ts、components/error-modal.tsx 及原生 diagnostics.rs/setup.rs；复制诊断后打开固定反馈说明，测试剪贴板失败仍可查看帮助。
- [x] 手机网页：更新 handoff/mod.rs 和 cmd/handoff_cmd.rs；无自有配置不启动，校验允许的 URL，增加原生边界测试。
- [x] 同步功能索引与开发 mock 的导航，检查所有 App 用户入口无上游默认网址。
- [x] 验证：前端针对性回归、TypeScript、生产构建、Rust 测试、改动文件 Prettier、git diff --check，并审查最终差异。

## 验证结果

前端 36 个测试文件、212 项测试通过；Rust 87 项通过，2 项依赖真实模型或公网媒体的集成测试按原约定忽略。TypeScript、生产前端构建、Rust 格式及改动文档/前端文件格式检查通过。构建仍有既有的大体积 JavaScript 分包提示。本轮未重新打包安装 App、部署手机网页或触发真实致命崩溃；对应行为通过源码检查和自动测试验证。
