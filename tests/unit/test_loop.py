from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from pydantic import BaseModel

from sztu_code.core.compact.compactor import Compactor
from sztu_code.core.context import ExecutionContext
from sztu_code.core.events.bus import EventBus
from sztu_code.core.llm.types import LlmResponse, ToolCallBlock, UsageStats
from sztu_code.core.loop import AgentLoop
from sztu_code.core.permissions.denial_tracker import DenialTracker
from sztu_code.core.subagent.registry import BackgroundTaskRegistry
from sztu_code.core.tools.base import BaseTool, ToolResult
from sztu_code.core.tools.registry import ToolRegistry

# --- stubs -------------------------------------------------------------------


class _MockProvider:
    """Returns canned responses in order; raises exc immediately if given."""

    def __init__(
        self,
        responses: list[LlmResponse],
        exc: BaseException | None = None,
    ) -> None:
        self._responses = iter(responses)
        self._exc = exc

    async def chat(
        self,
        messages: list[dict[str, object]],
        tool_schemas: list[dict[str, object]],
        bus: EventBus,
        run_id: str,
        *,
        step: int = 0,
        system: str | None = None,
    ) -> LlmResponse:
        if self._exc is not None:
            raise self._exc
        return next(self._responses)


class _CompactingProvider:
    """Returns a high-water tool_use/max_tokens call, a summary call, then end_turn."""

    def __init__(
        self,
        summary_text: str,
        first_stop_reason: str = "tool_use",
        with_tool_call: bool = True,
    ) -> None:
        self._summary_text = summary_text
        self._first_stop_reason = first_stop_reason
        self._with_tool_call = with_tool_call
        self._calls = 0

    async def chat(
        self,
        messages: list[dict[str, object]],
        tool_schemas: list[dict[str, object]],
        bus: EventBus,
        run_id: str,
        *,
        step: int = 0,
        system: str | None = None,
    ) -> LlmResponse:
        self._calls += 1
        if self._calls == 1:
            tool_calls = [_tc(inp={"msg": "hi"})] if self._with_tool_call else []
            return LlmResponse(
                stop_reason=self._first_stop_reason,
                tool_calls=tool_calls,
                text="" if tool_calls else "partial",
                usage=UsageStats(
                    input_tokens=100_000,
                    output_tokens=10,
                    context_pct=0.9,
                ),
            )
        if run_id == "compact":
            return LlmResponse(
                stop_reason="end_turn",
                text=self._summary_text,
                usage=UsageStats(input_tokens=100_000, output_tokens=2),
            )
        return LlmResponse(
            stop_reason="end_turn",
            text="done",
            usage=UsageStats(input_tokens=200, output_tokens=10),
        )


class _EchoTool(BaseTool):
    name = "echo"
    description = "Echoes msg"
    input_schema: dict[str, object] = {
        "type": "object",
        "properties": {"msg": {"type": "string"}},
        "required": ["msg"],
    }

    async def invoke(self, params: dict[str, object]) -> ToolResult:
        return ToolResult(content=str(params["msg"]))


class _FailTool(BaseTool):
    name = "fail"
    description = "Always raises"
    input_schema: dict[str, object] = {"type": "object", "properties": {}, "required": []}

    async def invoke(self, params: dict[str, object]) -> ToolResult:
        raise RuntimeError("tool error")


# --- helpers -----------------------------------------------------------------


def _ctx(max_steps: int = 5) -> ExecutionContext:
    return ExecutionContext(run_id="r1", goal="test goal", max_steps=max_steps)


def _tc(name: str = "echo", inp: dict[str, object] | None = None, uid: str = "t1") -> ToolCallBlock:
    return ToolCallBlock(id=uid, name=name, input=inp or {"msg": "hi"})


_SUMMARY = """\
## 1. Original Goal
test goal
## 2. Completed Steps
- echo tool called
## 3. Key Constraints & Discoveries
- none
## 4. Current File State
- none
## 5. Remaining TODOs
- finish
## 6. Critical Data
- none
"""


def _make_loop(
    provider: _MockProvider,
    registry: ToolRegistry | None = None,
    bus: EventBus | None = None,
) -> tuple[AgentLoop, EventBus]:
    b = bus or EventBus()
    return AgentLoop(provider, registry or ToolRegistry(), b), b  # type: ignore[arg-type]


async def _events(bus: EventBus) -> list[BaseModel]:
    collected: list[BaseModel] = []

    async def _h(e: BaseModel) -> None:
        collected.append(e)

    bus.subscribe(_h)
    return collected


# --- tests -------------------------------------------------------------------


# 功能：验证 LLM 返回 end_turn 时 loop 将 context 标记为 success
# 设计：单步 provider 直接返回 end_turn，最简正常路径，确认 loop 的基本终止逻辑
async def test_end_turn_marks_success() -> None:
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="done")])
    loop, _ = _make_loop(provider)
    ctx = _ctx()
    await loop.run(ctx)
    assert ctx.status == "success"
    assert ctx.step == 1


# 功能：验证达到 max_steps 时 loop 以 exceeded_max_steps 原因将 context 标记为 failed
# 设计：设置 max_steps=2 + 无限 tool_use provider，同时验证 step 数量和失败原因，确认计数器与终止逻辑联动正确
async def test_max_steps_marks_failed() -> None:
    tc = _tc("unknown", {})
    provider = _MockProvider([LlmResponse(stop_reason="tool_use", tool_calls=[tc])] * 10)
    loop, _ = _make_loop(provider)
    ctx = _ctx(max_steps=2)
    await loop.run(ctx)
    assert ctx.status == "interrupted"
    assert ctx.reason == "exceeded_max_steps"
    assert ctx.step == 2


# 功能：验证"调工具 → end_turn"的两步路径最终标记为 success
# 设计：provider 返回 [tool_use, end_turn] 序列，注册真实 EchoTool，覆盖最常见的正常工作路径
async def test_tool_use_then_end_turn_marks_success() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc()]),
        LlmResponse(stop_reason="end_turn", text="summary"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx()
    await loop.run(ctx)
    assert ctx.status == "success"
    assert ctx.step == 2


# 功能：验证工具结果按 Anthropic 格式（tool_result user 消息）追加到消息历史
# 设计：检查 messages[2]（tool_result 所在位置），断言 tool_use_id 和 content，确认 loop 正确调用了 context.add_tool_result
async def test_tool_result_appended_to_context() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc(inp={"msg": "hello"})]),
        LlmResponse(stop_reason="end_turn"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx()
    await loop.run(ctx)
    # messages: [goal, assistant(tool_use), user(tool_result), assistant(end_turn)]
    tool_result_msg = ctx.messages[2]
    assert tool_result_msg["role"] == "user"
    block = tool_result_msg["content"][0]  # type: ignore[index]
    assert block["tool_use_id"] == "t1"
    assert block["content"] == "hello"


# 功能：验证工具失败时 loop 不终止，而是将错误追加上下文让 LLM 重新决策
# 设计：工具始终 raise + provider 第二步返回 end_turn，确认 loop 最终到达 success；这是 agent 区别于普通脚本的核心特性
async def test_tool_failure_loop_continues_to_success() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("fail", {})]),
        LlmResponse(stop_reason="end_turn", text="handled error"),
    ])
    registry = ToolRegistry()
    registry.register(_FailTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx()
    await loop.run(ctx)
    assert ctx.status == "success"
    assert ctx.step == 2


# 功能：验证工具失败的错误信息以 is_error=True 追加进上下文，让 LLM 能感知工具调用失败
# 设计：检查 tool_result block 中的 is_error 标记，与 test_tool_failure_loop_continues_to_success 互补
async def test_tool_failure_result_is_error_in_context() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("fail", {})]),
        LlmResponse(stop_reason="end_turn"),
    ])
    registry = ToolRegistry()
    registry.register(_FailTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx()
    await loop.run(ctx)
    tool_result_msg = ctx.messages[2]
    block = tool_result_msg["content"][0]  # type: ignore[index]
    assert block.get("is_error") is True


# 功能：验证高水位 tool_use 会触发自动压缩，并将 context 标记为已压缩
# 设计：真实 Compactor + mock provider 返回工具调用和摘要，检查消息被摘要替换且事件发布
async def test_loop_auto_compacts_on_high_water_tool_use(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(_EchoTool())
    bus = EventBus()
    events = await _events(bus)
    provider = _CompactingProvider(_SUMMARY)
    compactor = Compactor(bus, tmp_path, "sess-1")
    loop = AgentLoop(
        provider,
        registry,
        bus,
        compactor=compactor,
        compact_threshold=0.8,
    )
    ctx = _ctx(max_steps=5)

    await loop.run(ctx)
    # Phase 3a: 异步压缩在后台执行，等待完成
    await asyncio.sleep(0.1)

    assert ctx.compacted is True
    assert ctx.messages[0]["role"] == "user"
    assert "Original Goal" in ctx.messages[0]["content"]
    assert "context.compacting" in [e.type for e in events]  # type: ignore[attr-defined]
    assert "context.compacted" in [e.type for e in events]  # type: ignore[attr-defined]


# 功能：验证非 tool_use 的继续状态（max_tokens）也会触发压缩
async def test_loop_auto_compacts_on_max_tokens(tmp_path: Path) -> None:
    bus = EventBus()
    provider = _CompactingProvider(
        _SUMMARY,
        first_stop_reason="max_tokens",
        with_tool_call=False,
    )
    compactor = Compactor(bus, tmp_path, "sess-1")
    loop = AgentLoop(
        provider,
        ToolRegistry(),
        bus,
        compactor=compactor,
        compact_threshold=0.8,
    )
    ctx = _ctx(max_steps=5)

    await loop.run(ctx)
    # Phase 3a: 等待异步压缩完成
    await asyncio.sleep(0.1)

    assert ctx.compacted is True
    assert ctx.status == "success"


# 功能：验证收到 CancelledError 时 loop 将 context 标记为 cancelled 后继续上抛 CancelledError
# 设计：用 pytest.raises 捕获 CancelledError，同时检查 context.status，确认优雅退出行为：先记录状态，再传播取消信号
async def test_cancelled_error_marks_failed_and_reraises() -> None:
    provider = _MockProvider([], exc=asyncio.CancelledError())
    loop, _ = _make_loop(provider)
    ctx = _ctx()
    with pytest.raises(asyncio.CancelledError):
        await loop.run(ctx)
    assert ctx.status == "failed"
    assert ctx.reason == "cancelled"


# 功能：验证 LLM 调用异常被捕获并标记为 llm_error，不向上传播
# 设计：provider 抛 RuntimeError，确认 loop 不崩溃、context 状态为 failed/llm_error，异常被正确吸收
async def test_llm_api_error_marks_failed() -> None:
    provider = _MockProvider([], exc=RuntimeError("api error"))
    loop, _ = _make_loop(provider)
    ctx = _ctx()
    await loop.run(ctx)
    assert ctx.status == "failed"
    assert ctx.reason == "llm_error"


# 功能：验证每个步骤都发布 step.started 和 step.finished 事件
# 设计：注入 bus + 事件收集器，检查事件类型集合，确认步骤级事件的可观测性（S2 TUI 依赖这两个事件显示进度）
async def test_step_started_and_finished_events_published() -> None:
    bus = EventBus()
    events = await _events(bus)
    provider = _MockProvider([LlmResponse(stop_reason="end_turn")])
    loop, _ = _make_loop(provider, bus=bus)
    ctx = _ctx()
    await loop.run(ctx)
    types = [e.type for e in events]  # type: ignore[attr-defined]
    assert "step.started" in types
    assert "step.finished" in types


# 功能：验证多步执行后 step 计数器正确累积到步数总量
# 设计：三步序列 [tool_use, tool_use, end_turn]，确认 step==3，排除计数器初始化错误或某步未递增的情况
async def test_step_counter_increments_across_steps() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc()]),
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc()]),
        LlmResponse(stop_reason="end_turn"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.step == 3
    assert ctx.status == "success"


# 功能：验证 LLM 文本响应以正确的 content block 格式追加到消息历史
# 设计：检查 messages[1] 的 role 和 content block 结构，确认 loop 构造的 assistant 消息符合 Anthropic 格式
async def test_assistant_message_blocks_added_to_context() -> None:
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="answer")])
    loop, _ = _make_loop(provider)
    ctx = _ctx()
    await loop.run(ctx)
    assistant_msg = ctx.messages[1]
    assert assistant_msg["role"] == "assistant"
    blocks = assistant_msg["content"]
    assert blocks[0]["type"] == "text"  # type: ignore[index]
    assert blocks[0]["text"] == "answer"  # type: ignore[index]


# ── denial tracker 集成测试 ────────────────────────────────────────────────────


class _PermissionDenyTool(BaseTool):
    """模拟权限被拒绝的工具，返回 permission_denied 错误。"""

    name = "deny_tool"
    description = "Always returns permission_denied"
    input_schema: dict[str, object] = {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "required": ["x"],
    }

    async def invoke(self, params: dict[str, object]) -> ToolResult:
        return ToolResult(
            content="Permission denied by user.",
            is_error=True,
            error_type="permission_denied",
        )


# 功能：验证连续 permission_denied 触发 DenialTracker 注入干预消息到上下文
# 设计：用 _PermissionDenyTool + DenialTracker(max_consecutive=2, max_total=100)，
#       验证第 3 次工具调用前 context.messages 中出现干预消息（以 role=user 且包含 tool name）
async def test_denial_tracker_injects_intervention_message() -> None:
    tc = _tc("deny_tool", {"x": "1"}, uid="td1")
    # 步骤 1-2：tool_use（被拒绝），步骤 3：end_turn
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="end_turn", text="switched strategy"),
    ])
    registry = ToolRegistry()
    registry.register(_PermissionDenyTool())
    bus = EventBus()
    # max_consecutive=2 所以第 2 次拒绝后触发干预
    denial_tracker = DenialTracker(max_consecutive=2, max_total=100)
    loop = AgentLoop(
        provider, registry, bus,
        denial_tracker=denial_tracker,
    )
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)

    # 干预消息应出现在 context.messages 中（role=user, 非 assistant/tool_result）
    intervention_msgs = [
        m for m in ctx.messages
        if m["role"] == "user"
        and isinstance(m["content"], str)
        and "repeatedly rejected" in str(m["content"])
    ]
    assert len(intervention_msgs) >= 1, (
        f"Expected intervention message in context, got messages: {ctx.messages}"
    )
    # 最终应成功
    assert ctx.status == "success"


# 功能：验证 DenialTracker 发布 denial.intervention 事件
# 设计：订阅 bus 收集事件，确认 DenialInterventionEvent 出现在事件流中
async def test_denial_tracker_publishes_intervention_event() -> None:
    tc = _tc("deny_tool", {"x": "1"}, uid="td2")
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_PermissionDenyTool())
    bus = EventBus()
    events: list[BaseModel] = []

    async def _collect(e: BaseModel) -> None:
        events.append(e)

    bus.subscribe(_collect)

    denial_tracker = DenialTracker(max_consecutive=2, max_total=100)
    loop = AgentLoop(
        provider, registry, bus,
        denial_tracker=denial_tracker,
    )
    ctx = _ctx(max_steps=5)
    await loop.run(ctx)

    intervention_events = [
        e for e in events
        if getattr(e, "type", "") == "denial.intervention"
    ]
    assert len(intervention_events) == 1
    evt = intervention_events[0]
    assert getattr(evt, "tool_name", "") == "deny_tool"
    assert getattr(evt, "total_denials", 0) >= 2


# ── 后台 subagent 等待集成测试 ─────────────────────────────────────────────────


# 功能：end_turn 前若有后台 subagent 未完成，loop 等待其落定后才标记 success
# 设计：注册被 Event 阻塞的后台任务，run_task 异步跑 loop，断言等待期间 run_task 未完成，
#       放行 Event 后 loop 才结束，且 result 含后台子 agent 的结果摘要
async def test_loop_waits_for_background_before_end_turn() -> None:
    gate = asyncio.Event()

    async def _bg() -> None:
        await gate.wait()

    child_ctx = ExecutionContext(run_id="bg-1", goal="bg", max_steps=1, result="bg done")
    registry = BackgroundTaskRegistry()
    registry.register("bg-1", asyncio.create_task(_bg()), child_ctx)

    ctx = _ctx()
    ctx.pending_background_run_ids.add("bg-1")
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="done")])
    loop = AgentLoop(provider, ToolRegistry(), EventBus(), task_registry=registry)

    run_task = asyncio.create_task(loop.run(ctx))
    await asyncio.sleep(0.05)
    assert not run_task.done(), "loop must wait for the background task"

    gate.set()
    await asyncio.wait_for(run_task, 2.0)
    assert ctx.status == "success"
    assert "bg done" in ctx.result


# 功能：已完成后台任务不阻塞，end_turn 后立即结束且摘要进入 result
# 设计：预注册已完成的后台任务，断言 loop 不等待、状态为 success、结果含摘要
async def test_loop_background_already_done() -> None:
    async def _bg() -> None:
        return None

    child_ctx = ExecutionContext(run_id="bg-done", goal="bg", max_steps=1, result="already done")
    task = asyncio.create_task(_bg())
    await asyncio.sleep(0.01)  # 让后台任务先完成
    registry = BackgroundTaskRegistry()
    registry.register("bg-done", task, child_ctx)

    ctx = _ctx()
    ctx.pending_background_run_ids.add("bg-done")
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="done")])
    loop = AgentLoop(provider, ToolRegistry(), EventBus(), task_registry=registry)

    await asyncio.wait_for(loop.run(ctx), 2.0)
    assert ctx.status == "success"
    assert "already done" in ctx.result


# 功能：max_steps 触发失败时同样等待后台任务落定
# 设计：max_steps=1 + 阻塞后台任务，断言 loop 等后台结束才标记 exceeded_max_steps，摘要仍写入 result
async def test_loop_max_steps_still_waits() -> None:
    gate = asyncio.Event()

    async def _bg() -> None:
        await gate.wait()

    child_ctx = ExecutionContext(run_id="bg-m", goal="bg", max_steps=1, result="bg result")
    registry = BackgroundTaskRegistry()
    registry.register("bg-m", asyncio.create_task(_bg()), child_ctx)

    ctx = _ctx(max_steps=1)
    ctx.pending_background_run_ids.add("bg-m")
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("unknown", {})]),
    ])
    loop = AgentLoop(provider, ToolRegistry(), EventBus(), task_registry=registry)

    run_task = asyncio.create_task(loop.run(ctx))
    await asyncio.sleep(0.05)
    assert not run_task.done()

    gate.set()
    await asyncio.wait_for(run_task, 2.0)
    assert ctx.status == "interrupted"
    assert ctx.reason == "exceeded_max_steps"
    assert "bg result" in ctx.result


# 功能：未传入 task_registry 时 pending 集合被忽略，loop 不等待不报错
# 设计：有 pending 但 task_registry=None，断言 loop 正常完成（旧构造点安全）
async def test_loop_no_registry_no_wait() -> None:
    ctx = _ctx()
    ctx.pending_background_run_ids.add("bg-x")
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="done")])
    loop = AgentLoop(provider, ToolRegistry(), EventBus())

    await asyncio.wait_for(loop.run(ctx), 2.0)
    assert ctx.status == "success"


# ============================================================
# Claude Code 风格多条件终止测试
# ============================================================


class _RuntimeErrorTool(BaseTool):
    name = "flaky_tool"
    description = "Always raises runtime error"
    input_schema: dict[str, object] = {"type": "object", "properties": {}, "required": []}

    async def invoke(self, params: dict[str, object]) -> ToolResult:
        return ToolResult(content="something went wrong", is_error=True, error_type="runtime_error")


# 功能：验证同一工具运行时错误 ≥3 次触发 repeated_error 熔断
async def test_repeated_error_termination() -> None:
    tc = _tc("flaky_tool", {}, uid="fe1")
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="end_turn", text="should not reach"),
    ])
    registry = ToolRegistry()
    registry.register(_RuntimeErrorTool())
    loop = AgentLoop(provider, registry, EventBus())
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.status == "failed"
    assert ctx.reason == "repeated_error"
    assert ctx.step == 3


# 功能：验证权限拒绝不计入错误累积
async def test_permission_denied_not_accumulated() -> None:
    tc = _tc("deny_tool", {"x": "1"}, uid="pd1")
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc]),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_PermissionDenyTool())
    loop = AgentLoop(provider, registry, EventBus())
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.reason != "repeated_error"


# 功能：验证成功调用重置错误累积
async def test_success_resets_error_accumulator() -> None:
    tc_fail = _tc("flaky_tool", {}, uid="fe2")
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[tc_fail]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc_fail]),
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("echo", {"msg": "ok"}, uid="e1")]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc_fail]),
        LlmResponse(stop_reason="tool_use", tool_calls=[tc_fail]),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_RuntimeErrorTool())
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus())
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.status == "success"


# 功能：验证 end_turn 优先级高于 max_turns
async def test_end_turn_wins_over_max_turns() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("echo", {"msg": "1"}, uid="ew1")]),
        LlmResponse(stop_reason="tool_use", tool_calls=[_tc("echo", {"msg": "2"}, uid="ew2")]),
        LlmResponse(stop_reason="end_turn", text="all done"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus())
    ctx = _ctx(max_steps=3)
    await loop.run(ctx)
    assert ctx.status == "success"
    assert ctx.step == 3


# 功能：验证 context_pct > 98% 触发 blocking_limit
async def test_blocking_limit_termination() -> None:
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc("echo", {"msg": "hi"}, uid="bl1")],
            usage=UsageStats(input_tokens=100_000, output_tokens=10, context_pct=0.99),
        ),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus())
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.status == "interrupted"
    assert ctx.reason == "blocking_limit"


# ============================================================
# Phase 3 — P0 兜底线新增测试
# ============================================================


# 功能：验证 token 预算耗尽优先于 max_steps，不做 wrap_up 额外调用
# 设计：设 max_tokens=1 且 max_steps=10，应首先触发 max_tokens_exceeded
async def test_token_budget_stops_before_max_steps() -> None:
    tc = _tc()
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use", tool_calls=[tc],
            usage=UsageStats(input_tokens=100_000, output_tokens=100, context_pct=0.5),
        ),
    ] * 10)
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx(max_steps=10)
    ctx.max_tokens = 1  # token 预算立即耗尽，应跳过 max_steps 的 wrap_up
    await loop.run(ctx)
    assert ctx.status == "interrupted"
    assert ctx.reason == "max_tokens_exceeded"


# 功能：验证墙钟超时在 loop 内正确终止
# 设计：设 max_wall_clock_s=0（已超时），预检应触发中断
async def test_wall_clock_exceeded_stops_loop() -> None:
    provider = _MockProvider([LlmResponse(stop_reason="end_turn", text="ok")])
    loop, _ = _make_loop(provider)
    ctx = _ctx(max_steps=10)
    ctx.max_wall_clock_s = 1
    ctx.started_at = 0.0  # 确保 elapsed_s > 0
    # 模拟已运行超时：elapsed_s 会 >= max_wall_clock_s
    import time
    ctx.started_at = time.monotonic() - 10.0  # 10 秒前开始
    await loop.run(ctx)
    # 无 result 时 wall_clock 超时标记为 failed（区别于有结果的中断）
    assert ctx.status == "failed"
    assert ctx.reason == "max_wall_clock_exceeded"


# 功能：验证墙钟超时但有 result 时标记为 interrupted（保留已有结果）
# 设计：先正常完成一个 end_turn 拿到 result，再在下一轮超时
async def test_wall_clock_exceeded_preserves_result() -> None:
    provider = _MockProvider([
        LlmResponse(stop_reason="end_turn", text="final answer"),
    ])
    loop, _ = _make_loop(provider)
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)  # 先正常完成一次 run
    assert ctx.status == "success"
    assert ctx.result == "final answer"
    # 再次 run（模拟 resume），墙钟已超时
    ctx.status = "running"
    import time
    ctx.started_at = time.monotonic() - 10.0
    ctx.max_wall_clock_s = 1
    await loop.run(ctx)
    assert ctx.status == "interrupted"  # 有 result，保留
    assert ctx.result == "final answer"


# 功能：验证压缩通过累计 input tokens 绝对值触发
# 设计：设 auto_compact_min_tokens=50000，第一步 input=60000 应触发压缩
async def test_auto_compact_by_token_count(tmp_path: Path) -> None:
    compactor = Compactor(EventBus(), tmp_path, "sess-c")
    # 在不注入 provider 的情况下，压缩调用不会真正执行 LLM
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=60_000, output_tokens=10, context_pct=0.3),
        ),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(
        provider, registry, EventBus(),
        compactor=compactor,
        auto_compact_min_tokens=50_000,  # 第一步就超过此阈值
    )
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.status == "success"


# 功能：验证压缩通过步数绝对值触发
# 设计：设 auto_compact_min_steps=3，第 3 步应触发压缩
async def test_auto_compact_by_step_count(tmp_path: Path) -> None:
    compactor = Compactor(EventBus(), tmp_path, "sess-d")
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            # 低 context_pct 不会触发百分比阈值
            usage=UsageStats(input_tokens=1_000, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=1_000, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=1_000, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(
        provider, registry, EventBus(),
        compactor=compactor,
        compact_threshold=0.0,  # 禁用百分比触发
        auto_compact_min_tokens=0,  # 禁用 token 触发
        auto_compact_min_steps=3,  # 第 3 步触发
    )
    ctx = _ctx(max_steps=10)
    await loop.run(ctx)
    assert ctx.status == "success"


# 功能：验证 wrap_up_on_max_steps 在步数耗尽时触发额外 LLM 调用生成总结
# 设计：max_steps=2，最后一步为 tool_use，wrap_up 会额外调用 LLM
async def test_wrap_up_fires_on_max_steps() -> None:
    """wrap_up 在 max_steps 到达且未自然 end_turn 时生成总结"""
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        # wrap_up 调用（额外 LLM 调用，无工具）
        LlmResponse(stop_reason="end_turn", text="Task was working on X, file Y modified."),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus(),
                     grace_step_on_max_steps=False)  # 仅测 wrap_up
    ctx = _ctx(max_steps=2)
    await loop.run(ctx)
    assert ctx.status == "interrupted"
    assert ctx.reason == "exceeded_max_steps"
    assert "Task was working on X" in ctx.result


# 功能：验证 grace_step 在最后一步工具成功时追加无工具回合，[COMPLETE] 标记 → success
# 设计：max_steps=2，最后一步为成功 tool_use，conclude 返回 [COMPLETE] 文本
async def test_grace_step_complete_marker_marks_success() -> None:
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        # grace_step/conclude 调用 → 返回 [COMPLETE] 标记
        LlmResponse(stop_reason="end_turn", text="[COMPLETE] All tasks done."),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus(),
                     wrap_up_on_max_steps=False)  # 仅测 grace_step
    ctx = _ctx(max_steps=2)
    await loop.run(ctx)
    assert ctx.status == "success"


# 功能：验证 grace_step 中 [INCOMPLETE] 标记 → interrupted
# 设计：conclude 返回 [INCOMPLETE] 时保持 interrupted 状态
async def test_grace_step_incomplete_marker_marks_interrupted() -> None:
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[_tc()],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        # grace_step/conclude 调用 → 返回 [INCOMPLETE] 标记
        LlmResponse(stop_reason="end_turn", text="[INCOMPLETE] Still need to test."),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop = AgentLoop(provider, registry, EventBus(),
                     wrap_up_on_max_steps=False)
    ctx = _ctx(max_steps=2)
    await loop.run(ctx)
    assert ctx.status == "interrupted"
    assert ctx.reason == "exceeded_max_steps"
    assert "Still need to test" in ctx.result


# 功能：验证 max_steps=0 在运行时仍然表示不限步数
# 设计：end_turn 正常终止，不受 step 计数限制
async def test_max_steps_zero_runtime_unlimited() -> None:
    """max_steps=0 时 loop 不因步数限制终止，end_turn 正常退出"""
    tc = _tc()
    provider = _MockProvider([
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[tc],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(
            stop_reason="tool_use",
            tool_calls=[tc],
            usage=UsageStats(input_tokens=100, output_tokens=10, context_pct=0.01),
        ),
        LlmResponse(stop_reason="end_turn", text="done"),
    ])
    registry = ToolRegistry()
    registry.register(_EchoTool())
    loop, _ = _make_loop(provider, registry)
    ctx = _ctx(max_steps=0)  # 不限步数
    await loop.run(ctx)
    assert ctx.status == "success"
    assert ctx.step == 3  # 完整运行 3 步
