# SztuCode Desktop Workbench

这是 SztuCode 的现代图形客户端：Tauri 2 负责原生窗口、系统目录选择与受控 TCP 桥；Vue 3 负责任务时间线、会话历史、工作区、审批与变更审阅。

## 环境要求

- Node.js 20+
- Rust stable（`rustup`）
- 正在运行的 TypeScript daemon（仓库根目录 `npm run daemon`）
- 按 [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) 安装平台依赖：
  - **macOS**：Xcode Command Line Tools（`xcode-select --install`）
  - **Windows**：WebView2、Visual Studio C++ 构建工具
  - **Linux**：见官方文档中的发行版依赖列表

## 开发

先构建并启动 TypeScript daemon，再启动桌面端。

macOS / Linux：

```bash
# 终端 1：仓库根目录
npm run build
npm run daemon

# 终端 2
cd desktop
npm install
npm run tauri dev
```

Windows PowerShell：

```powershell
# 终端 1：仓库根目录
npm run build
npm run daemon

# 终端 2
cd desktop
npm install
npm run tauri dev
```

桌面端通过一个持久 TCP 连接与 daemon 通信。Rust 桥只转发 NDJSON 帧，所有 JSON-RPC 请求关联、事件订阅与重连状态由 `src/lib/ipc.ts` 集中处理。

macOS 使用系统 traffic lights 与 Overlay 标题栏（见 `src-tauri/tauri.macos.conf.json`）；该文件由 Tauri 构建与 `generate_context!()` 按平台自动合并进主配置（[Configuration Files](https://v2.tauri.app/develop/configuration-files/#platform-specific-configuration)），无需在 `main.rs` 中手动加载。Windows / Linux 继续使用自绘窗口按钮。

## 验证

```bash
cd desktop
npm run build
cd src-tauri
cargo check
```

视觉回归（需先安装 Playwright Chromium）：

```bash
cd desktop
npx playwright install chromium
npm run test:visual
```

可选：用 `PLAYWRIGHT_CHROMIUM_PATH` 指定浏览器可执行文件（跨平台路径均可，不要提交本机绝对路径到仓库）。

## 打包（本机）

```bash
cd desktop
npm run tauri build
```

产物位置大致为：

- macOS：`desktop/src-tauri/target/release/bundle/macos/*.app`，以及 `bundle/dmg/*.dmg`（若启用 dmg）
- Windows：`desktop/src-tauri/target/release/bundle/msi` 或 `nsis`
- Linux：`desktop/src-tauri/target/release/bundle` 下的 deb/AppImage 等

当前不要求代码签名或公证；未签名的 macOS `.app` 可能需要在「隐私与安全性」中允许打开。

旧的 Tkinter `sztu-desktop` 保留为兼容入口；新功能应优先加入此目录的 Tauri + Vue 3 客户端与共享 IPC 协议。
