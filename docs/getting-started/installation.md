# 安装与启动

[返回文档中心](../README.md)

## 环境要求

- Node.js 20+
- Git
- Anthropic 或 OpenAI-compatible API 凭据
- 桌面安装包当前还要求系统可执行 `node`（Node.js 20+）；开发构建另需 Rust 与平台对应的 Tauri 依赖

## 安装 TypeScript 运行时

```bash
git clone https://github.com/rojim666/SztuCode.git
cd SztuCode
npm install
npm run build
```

确认命令可用：

```bash
npm run cli -- ping
```

## 配置模型

```bash
cp .env.example .env
```

在 `.env` 中配置 Provider、模型 ID 和凭据。不要提交 `.env`。完整字段见 [配置参考](configuration.md)。

## 启动终端客户端

推荐入口：

```bash
npm run daemon
```

另一个终端使用 Node 终端客户端：

常用选项：

```bash
npm run cli -- ping
npm run cli -- run --goal "inspect the repository"
npm run cli -- chat
```

也可以手动分开运行 daemon 和客户端：

```bash
# 终端 1
npm run build
npm run daemon

# 终端 2
npm run cli -- chat
```

## 启动桌面端

桌面工作台会从安装资源启动 TypeScript daemon；当前版本需要系统 PATH 中存在 Node.js 20+。也可手动分开调试：

```bash
# 终端 1：仓库根目录
npm run build
npm run daemon

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
npm run cli -- ping
```

默认服务地址为 `127.0.0.1:7438`。若端口冲突，可通过环境变量修改 `SZTU_TS_PORT`，daemon 与客户端必须使用相同配置。

## 下一步

- [配置参考](configuration.md)
- [运维手册](../operations/runbook.md)
- [安全策略](../SECURITY.md)
- [贡献指南](../CONTRIBUTING.md)
