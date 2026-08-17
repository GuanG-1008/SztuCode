# AGENT.md

> Current product path: TypeScript. The daemon, Agent Loop, protocol, CLI, desktop IPC, and evaluation orchestrator live under `packages/`. Python code is legacy compatibility or artifact tooling unless a task explicitly targets it.

This file provides guidance to codex when working with code in this repository.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run docs:protocol
npm run docs:links
npm run daemon
npm run cli -- ping
npm run cli -- core stop
```

## Architecture

This is a local TypeScript agent system. The desktop application and TypeScript CLI connect to the persistent TypeScript daemon over JSON-RPC 2.0 NDJSON.

```
packages/runtime-ts (daemon)
  └─ listens on 127.0.0.1:7438 (TCP)
       ↑ JSON-RPC 2.0 NDJSON
packages/cli   desktop (Tauri)
```

**The Tauri desktop workbench is the primary frontend.** User-facing task management, observability, and interaction work should be designed and validated in `desktop/`. The Node `chat` command is the supported terminal interface; the retained Textual client under `src/sztu_code` is legacy and must not define new product contracts.

## Legacy Python Reference

The sections below describe the retained Python implementation. Use them only when modifying legacy compatibility code or Python-specific artifact tooling; they do not define the current product runtime.

### Protocol layer (`src/sztu_code/core/bus/`)

All IPC messages are typed pydantic v2 models with a **discriminated union on the `type` field**. This is the contract boundary — adding a new command or event means adding a new model class to `commands.py` or `events.py` and extending the `Command`/`Event` union.

- `envelope.py` — `JsonRpcRequest`, `JsonRpcSuccess`, `JsonRpcError`, error code constants, `make_error()`
- `commands.py` — `Command` union; currently only `PingCommand` + `PongResult`
- `events.py` — `Event` union; currently only `CoreStartedEvent`

The current `docs/reference/wire-protocol.md` is generated from `packages/protocol` by `npm run docs:protocol`. The Python generator is retained only for legacy compatibility.

### Transport layer (`src/sztu_code/core/transport/`)

- `socket_server.py` — TCP server (`asyncio.start_server`); reads NDJSON lines, dispatches to registered `CommandHandler`s, handles JSON-RPC error cases. On `start()`, probes `host:port` first — errors if another daemon is already listening. Handlers registered via `server.register("method.name", handler_fn)`.

### Config (`src/sztu_code/core/config.py`)

Four-tier priority: **built-in defaults → `~/.sztu/config.toml` → `.env` → env vars**.

The current daemon defaults to `127.0.0.1:7438`; Python S0 configuration below applies only to the legacy implementation.

Relevant env vars: `SZTU_CONFIG`, `SZTU_HOST`, `SZTU_PORT`, `SZTU_LOG_LEVEL`, `SZTU_LOG_FILE`, `SZTU_LOG_FORMAT`.

### Daemon entry (`src/sztu_code/core/app.py`)

`CoreApp.run()` is the single async entry point: loads config → sets up logging → creates `SocketServer` → registers handlers → waits for `SIGINT`/`SIGTERM` → calls `server.stop()`. Adding new handlers: instantiate a handler method on `CoreApp` and call `server.register()`.

### Testing

Integration tests in `tests/conftest.py` spawn a real daemon subprocess using a random free port (via `free_port` fixture). The fixture finds a free port, releases it, passes it to the daemon via `SZTU_PORT`, then polls `asyncio.open_connection` until the daemon is ready.

### Code style

All functions must have a **single-line Chinese comment** immediately above the `def` line explaining what the function does. Example:

```python
# 发送 JSON-RPC 响应并刷新写缓冲区
async def _send(self, writer: asyncio.StreamWriter, msg: BaseModel) -> None:
    ...
```

Do not write multi-line docstrings; one concise Chinese line is enough.

**Test functions** require **two Chinese comment lines** immediately above the `def` line:

```python
# 功能：验证 publish 后订阅者能收到事件对象
# 设计：用内联 handler 收集事件引用，断言 is 而非 ==，排除序列化中间步骤的干扰
async def test_publish_reaches_subscriber() -> None:
    ...
```

- `# 功能：` — 该测试验证的具体行为或不变式，一句话说清楚"测什么"
- `# 设计：` — 为什么选择这种测试方式：覆盖了什么边界条件、为什么用这个 stub/fixture、这种断言方式相比其他方式的优势

两行注释缺一不可。功能行让读者 5 秒内判断测试意图；设计行让读者理解测试背后的决策，而非只看到操作步骤。

### Project documentation

Current user, contributor, architecture, testing, and operations documentation lives in
`docs/`; start with `docs/README.md`. Historical proposals are kept under `docs/archive/`
and must not be treated as current behavior. Significant new architecture decisions should
use the ADR process in `docs/adr/README.md`.
