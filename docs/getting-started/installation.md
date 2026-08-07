# 安装与启动

[返回文档中心](../README.md)

## 环境要求

- Python `3.12.x`
- [uv](https://docs.astral.sh/uv/)
- Git
- Anthropic 或 OpenAI-compatible API 凭据
- 可选：Node.js 20+、Rust 与平台对应的 Tauri 构建依赖

## 安装 Python 运行时

```bash
git clone https://github.com/rojim666/SztuCode.git
cd SztuCode
uv sync
```

确认命令可用：

```bash
uv run sztu --version
uv run sztu --help
uv run sztucode --help
```

## 配置模型

```bash
cp .env.example .env
```

在 `.env` 中配置 Provider、模型 ID 和凭据。不要提交 `.env`。完整字段见 [配置参考](configuration.md)。

## 启动 TUI

推荐入口：

```bash
uv run sztucode /path/to/project
```

该命令会检查 daemon，并在未运行时自动启动。首次打开目录时，TUI 会要求选择是否信任工作区。

常用选项：

```bash
uv run sztucode . --trust
uv run sztucode . --read-only
uv run sztucode . --replay RUN_ID
```

也可以手动分开运行 daemon 和客户端：

```bash
# 终端 1
uv run sztu-code

# 终端 2
uv run sztu-tui
```

## 启动桌面端

桌面工作台目前不会自动启动 Python daemon：

```bash
# 终端 1：仓库根目录
uv run sztu-code

# 终端 2
cd desktop
npm install
npm run tauri dev
```

Tauri 在不同操作系统上的系统依赖不同，请按 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) 安装对应工具链。

### macOS 补充

- 安装 Xcode Command Line Tools：`xcode-select --install`
- 需要 Node.js 20+ 与 Rust stable（`rustup`）
- 本机打包：`cd desktop && npm run tauri build`，产物通常在 `desktop/src-tauri/target/release/bundle/macos/`（`.app`）与 `bundle/dmg/`（若生成）
- 更完整的桌面端说明见 [Desktop README](../../desktop/README.md)

## 验证连通性

```bash
uv run sztu ping
uv run sztu core status
```

默认服务地址为 `127.0.0.1:7437`。若端口冲突，可在 `.env` 或环境变量中修改 `SZTU_PORT`，daemon 与客户端必须使用相同配置。

## 下一步

- [配置参考](configuration.md)
- [运维手册](../operations/runbook.md)
- [安全策略](../SECURITY.md)
- [贡献指南](../CONTRIBUTING.md)
