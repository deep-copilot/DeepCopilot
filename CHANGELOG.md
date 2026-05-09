# Changelog

All notable changes to **DeepPilot** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.17.0] – 2026-05-09

### 🎉 Public release as **DeepPilot**

Renamed from internal `deepseek-agent`. First public, open-source, MIT-licensed release.

### Added
- **三栏工作区布局**：Plan/Todos · Chat · Sessions（替代原右侧抽屉）
- **Copilot 风格的会话记忆**：每个 workspace 自动隔离会话历史，重新打开项目自动恢复最近对话
- **会话作用域切换**：📁 仅本工作区 / 🌐 全部
- 会话搜索 / 重命名 / 删除
- 按时间分组（今天 / 昨天 / 本周 / 更早）

### Changed
- 工具栏图标语义重排：▦ 切左栏，☰ 切右栏
- README、品牌资源、配置标题统一改为 DeepPilot

### Internal
- 配置键 `deepseekAgent.*` 与命令 ID 暂保留向后兼容（计划在 1.0 切到 `deeppilot.*`）

---

## 0.10.0 – 0.16.0 (pre-release, internal)

简要回顾：

- v0.16: ☰ 抽屉式会话面板 + globalState 持久化
- v0.15: Markdown 块级渲染 + 思考默认折叠
- v0.14: 紧凑工具卡片 + 去 emoji 系统提示
- v0.13: 文件链接 + 跳转
- v0.12: 复制 / 插入代码按钮
- v0.11: 4 档审批策略 + SecretStorage 存 API Key
- v0.10: 多面板 TUI 雏形

[0.17.0]: https://github.com/ZhouChaunge/DeepPilot/releases/tag/v0.17.0
