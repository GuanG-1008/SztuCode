# 开发环境

[返回文档中心](../README.md)

## Python 开发

```bash
git clone https://github.com/rojim666/SztuCode.git
cd SztuCode
uv sync
```

常用命令：

```bash
uv run ruff check src tests scripts
uv run mypy src
uv run pytest tests/unit -v
uv run pytest tests/integration -v
uv run python scripts/gen_protocol_doc.py --check
```

启动 daemon 进行手动调试：

```bash
uv run sztu-code
```

另一个终端中：

```bash
uv run sztu ping
uv run sztu run --goal "inspect the repository"
uv run sztu trace --follow
```

## 桌面端开发

前端位于 `desktop/`，技术栈为 Vue 3、TypeScript、Vite 和 Tauri 2。

```bash
cd desktop
npm install
npm run build
npm run tauri dev
```

Rust 桥接层检查：

```bash
cd desktop/src-tauri
cargo check
```

桌面端依赖正在运行的 Python daemon。前端开发服务器端口由 `desktop/vite.config.ts` 决定，Tauri 开发入口由 `desktop/src-tauri/tauri.conf.json` 配置。

## 模块修改清单

### 协议层

- 修改 `core/bus/commands.py` 或 `events.py`；
- 更新联合类型和 daemon handler；
- 检查 CLI、TUI 与桌面 Client SDK；
- 重新生成 Wire Protocol；
- 添加 round-trip 和集成测试。

### 工具层

- 实现参数 Pydantic 模型；
- 声明静态权限或实现动态权限分类；
- 注册工具；
- 覆盖参数错误、运行失败、超时和权限拒绝；
- 验证工具不能越过工作区边界。

### UI 层

- 保持事件按 `session_id` / `run_id` 关联；
- 重连和历史 hydrate 不得产生重复状态；
- 覆盖 loading、空、失败、禁用和审批状态；
- 桌面端变更运行 TypeScript 构建与必要的视觉验证。

### 配置层

- 更新 dataclass、TOML 校验和环境变量覆盖；
- 更新 `.env.example` 和配置参考；
- 为无效类型、边界值和优先级添加测试；
- 明确是否包含凭据及其持久化方式。

## 数据与调试

开发时常用位置：

```text
~/.sztu/logs/core.log
~/.sztu/logs/tui.log
~/.sztu/traces/daemon.jsonl
~/.sztu/sessions/
```

这些文件可能包含提示词、模型响应、工具输出和 API 配置。提交 Issue 或测试夹具前必须脱敏。

## 完成标准

一项变更在满足以下条件后才适合提交：

- 行为与 Issue/PR 目标一致；
- 相关客户端和协议消费者已同步；
- 适当测试通过；
- 失败和权限路径经过验证；
- 用户文档与配置示例已更新；
- `git diff` 不包含无关生成物或本机数据。
