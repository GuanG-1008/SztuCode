from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sztu_code.core.bus.events import (
    StepFinishedEvent,
    StepStartedEvent,
    StuckLoopEvent,
)
from sztu_code.core.compact.budget import truncate_tool_results
from sztu_code.core.context import ContinueReason, ExecutionContext, TerminationReason
from sztu_code.core.events.bus import EventBus
from sztu_code.core.llm.base import LLMProvider
from sztu_code.core.stuck_tracker import stuck_signature
from sztu_code.core.tools.invocation import invoke_tool
from sztu_code.core.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from sztu_code.core.compact.canvas import TaskCanvas
    from sztu_code.core.compact.compactor import Compactor
    from sztu_code.core.compact.offload import OffloadManager
    from sztu_code.core.permissions.denial_tracker import DenialTracker
    from sztu_code.core.permissions.manager import PermissionManager
    from sztu_code.core.stuck_tracker import StuckLoopTracker
    from sztu_code.core.subagent.registry import BackgroundTaskRegistry


log = logging.getLogger(__name__)

# 默认系统提示词，供主调用与收尾回合复用
_DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful AI assistant. "
    "Use the available tools to complete the user's goal. "
    "When the goal is fully achieved, respond with a final answer "
    "and do not call any more tools."
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class AgentLoop:
    # 初始化循环所需依赖：LLM provider、工具注册表、事件总线、
    # 以及可选的权限管理器、拒绝追踪器、压缩器、卸载管理器和 session ID
    def __init__(
        self,
        provider: LLMProvider,
        registry: ToolRegistry,
        bus: EventBus,
        *,
        permission_manager: PermissionManager | None = None,
        denial_tracker: DenialTracker | None = None,
        compactor: Compactor | None = None,
        compact_threshold: float = 0.80,
        auto_compact_min_tokens: int = 0,
        auto_compact_min_steps: int = 0,
        tool_result_limit: int = 8_000,
        tool_result_keep: int = 4_000,
        session_id: str = "",
        task_registry: BackgroundTaskRegistry | None = None,
        offload_manager: OffloadManager | None = None,
        wrap_up_on_max_steps: bool = True,
        grace_step_on_max_steps: bool = True,
        stuck_tracker: StuckLoopTracker | None = None,
        # 滑动窗口压缩参数
        sliding_window_size: int = 5,
        compact_cooldown_steps: int = 3,
        circuit_breaker_max_failures: int = 3,
    ) -> None:
        self._provider = provider
        self._registry = registry
        self._bus = bus
        self._permission_manager = permission_manager
        self._denial_tracker = denial_tracker
        self._compactor = compactor
        self._compact_threshold = compact_threshold
        self._auto_compact_min_tokens = auto_compact_min_tokens
        self._auto_compact_min_steps = auto_compact_min_steps
        self._tool_result_limit = tool_result_limit
        self._tool_result_keep = tool_result_keep
        self._session_id = session_id
        self._task_registry = task_registry
        self._offload_manager = offload_manager
        self._wrap_up_on_max_steps = wrap_up_on_max_steps
        self._grace_step_on_max_steps = grace_step_on_max_steps
        self._stuck_tracker = stuck_tracker
        # 滑动窗口压缩配置
        self._sliding_window_size = sliding_window_size
        self._compact_cooldown_steps = compact_cooldown_steps
        self._circuit_breaker_max_failures = circuit_breaker_max_failures
        # 压缩冷却期：两次压缩之间至少间隔 N 步；冷启动即可触发
        self._last_compact_step: int = -15
        # 熔断器日志去重：避免每步都刷屏
        self._circuit_breaker_logged: bool = False

    # 驱动 plan→act→observe 循环直到上下文终止；CancelledError 向上传播
    async def run(self, context: ExecutionContext) -> None:
        # Phase 2: 初始化任务画布（若未由外部注入）
        from sztu_code.core.compact.canvas import TaskCanvas
        if context.canvas is None:
            context.canvas = TaskCanvas()
        canvas: TaskCanvas = context.canvas

        while not context.is_done():
            # Ensure a prepared summary replaces the oversized snapshot before
            # the next model request instead of only at runner shutdown.
            if self._compactor is not None:
                await self._compactor.wait_pending()
            # 惰性记录 run 开始墙钟（runner/子 agent 都可能未设置）
            if context.started_at <= 0.0:
                context.started_at = time.monotonic()

            # [budget] 墙钟上限预检：超时直接终止，不再发起 LLM 调用
            # 若已有 result（上一步已产出内容），优先保留而非丢弃
            if context.wall_clock_exceeded():
                if context.result:
                    context.mark_interrupted("max_wall_clock_exceeded")
                else:
                    context.mark_failed("max_wall_clock_exceeded")
                break

            context.step += 1
            await self._bus.publish(
                StepStartedEvent(run_id=context.run_id, step=context.step, ts=_now())
            )

            # [intervene] 连续拒绝达到阈值时注入熔断消息，强制 LLM 换策略
            if self._denial_tracker is not None and self._denial_tracker.should_intervene():
                msg = self._denial_tracker.intervention_message()
                context.messages.append({"role": "user", "content": msg})
                # 发布熔断事件供 TUI 渲染
                snap = self._denial_tracker.snapshot()
                from sztu_code.core.bus.events import DenialInterventionEvent
                if snap["consecutive"]:
                    worst_tool = max(snap["consecutive"], key=snap["consecutive"].get)
                    worst_count = snap["consecutive"][worst_tool]
                else:
                    worst_tool = "unknown"
                    worst_count = 0
                await self._bus.publish(
                    DenialInterventionEvent(
                        run_id=context.run_id,
                        tool_name=str(worst_tool),
                        consecutive_count=worst_count,
                        total_denials=snap["total"],
                        message=msg,
                        ts=_now(),
                    )
                )
                self._denial_tracker.reset_intervention()

            # [intervene] 连续同签名失败达到阈值时注入卡死干预消息，强制 LLM 换策略
            if self._stuck_tracker is not None and self._stuck_tracker.should_intervene():
                msg = self._stuck_tracker.intervention_message()
                context.messages.append({"role": "user", "content": msg})
                snap = self._stuck_tracker.snapshot()
                await self._bus.publish(
                    StuckLoopEvent(
                        run_id=context.run_id,
                        signature=snap["worst_signature"],
                        consecutive_count=snap["worst_count"],
                        total_interventions=snap["interventions"],
                        message=msg,
                        ts=_now(),
                    )
                )
                self._stuck_tracker.reset_intervention()
                # 硬停：累计干预达到阈值直接终止
                if self._stuck_tracker.hard_stop_reached():
                    context.mark_failed("stuck_loop")
                    break

            # [plan] call LLM — API errors terminate the run
            try:
                response = await self._provider.chat(
                    messages=truncate_tool_results(
                        context.messages,
                        limit=self._tool_result_limit,
                        keep=self._tool_result_keep,
                    ),
                    tool_schemas=self._registry.tool_schemas(),
                    bus=self._bus,
                    run_id=context.run_id,
                    step=context.step,
                    system=context.system_prompt(
                        context.base_system_prompt or _DEFAULT_SYSTEM_PROMPT
                    ),
                )
            except asyncio.CancelledError:
                context.mark_failed("cancelled")
                raise
            except Exception:
                logging.getLogger(__name__).exception(
                    "LLM call failed run_id=%s step=%d", context.run_id, context.step
                )
                context.mark_failed("llm_error")
                break

            # [budget] 累计本步 LLM 用量
            if response.usage is not None:
                context.total_input_tokens += response.usage.input_tokens
                context.total_output_tokens += response.usage.output_tokens
                context.total_cache_read_input_tokens += response.usage.cache_read_input_tokens

            # 在写入历史前补齐工具调用标题，确保回放与实时事件使用同一份参数
            for tool_call in response.tool_calls:
                tool_call.input = self._registry.enrich_tool_input(tool_call.name, tool_call.input)

            # [observe] append assistant content blocks to context
            # thinking blocks must come first and be preserved verbatim for extended thinking mode
            blocks: list[dict[str, object]] = list(response.thinking_blocks)
            if response.text:
                blocks.append({"type": "text", "text": response.text})
            for tc in response.tool_calls:
                blocks.append(
                    {"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.input}
                )
            context.add_assistant_message(blocks)

            # [act] execute each requested tool; errors become tool results so loop continues
            added_estimate = 0
            # 收集工具调用信息用于画布记录
            canvas_tool_names: list[str] = []
            canvas_summaries: list[str] = []
            canvas_refs: list[str] = []
            has_errors = False
            if response.stop_reason == "tool_use":
                # Phase 2: 先创建 running 状态节点
                if response.tool_calls:
                    canvas.record_step(
                        label=response.text.strip()[:80] if response.text else "",
                        tool_names=[tc.name for tc in response.tool_calls],
                        status="running",
                    )
                for tc in response.tool_calls:
                    canvas_tool_names.append(tc.name)
                    result = await invoke_tool(
                        self._registry, tc, self._bus, context.run_id,
                        permission_manager=self._permission_manager,
                        session_id=self._session_id,
                    )
                    if result.is_error:
                        has_errors = True
                        # Claude Code 风格错误累积：非权限类错误 ≥3 次触发熔断
                        if result.error_type != "permission_denied":
                            context.record_error(tc.name, result.error_type or "runtime_error")
                    else:
                        context.record_success()
                    # 上下文卸载：将超长工具结果写入外部 refs/*.md，上下文仅保留占位符
                    # 参考 TencentDB Agent Memory Level 0-1 架构
                    content = result.content
                    if (
                        self._offload_manager is not None
                        and self._offload_manager.should_offload(tc.name, content)
                    ):
                        record = self._offload_manager.offload(
                            tc.name, tc.id, content, context.run_id, result.is_error,
                        )
                        canvas_summaries.append(record.summary)
                        canvas_refs.append(record.ref_path)
                        content = self._offload_manager.placeholder(record)
                    else:
                        # 未卸载的工具结果：用内容首行作为摘要
                        first_line = content.strip().split("\n")[0][:100] if content.strip() else ""
                        canvas_summaries.append(first_line)
                    added_estimate += max(1, len(content) // 4)
                    context.add_tool_result(tc.id, content, is_error=result.is_error)

                    # [track] 追踪权限拒绝，触发熔断干预
                    if self._denial_tracker is not None:
                        if result.error_type == "permission_denied":
                            self._denial_tracker.record_denial(tc.name)
                        elif not result.is_error:
                            self._denial_tracker.record_success(tc.name)

                    # [track] 追踪同签名失败，触发卡死干预/硬停
                    if self._stuck_tracker is not None:
                        if result.is_error:
                            self._stuck_tracker.record_failure(stuck_signature(tc))
                        else:
                            self._stuck_tracker.record_success(stuck_signature(tc))

                # Phase 2: 更新画布节点 — running → done/failed，补齐摘要和 refs
                if canvas_tool_names:
                    canvas.finalize_last(
                        label=response.text.strip() if response.text else "",
                        status="failed" if has_errors else "done",
                        summary="; ".join(canvas_summaries[:3]),
                        refs=canvas_refs,
                    )
                    context.add_canvas_update()

            elif response.stop_reason == "max_tokens" and response.tool_calls:
                # Output token limit hit mid-tool-call; input is incomplete.
                # Add synthetic error results so the conversation stays balanced.
                for tc in response.tool_calls:
                    error_text = (
                        "Error: output token limit reached before this tool call "
                        "could be completed. Please break the task into smaller "
                        "steps and try again."
                    )
                    added_estimate += max(1, len(error_text) // 4)
                    context.add_tool_result(
                        tc.id,
                        error_text,
                        is_error=True,
                    )

            # 仅在真正终止的那一步（end_turn 或 max_steps 已到）才等待后台 subagent 落定，
            # 避免中间 tool_use 步骤过早清空 pending 导致最终摘要丢失
            pending_summaries: list[str] = []
            if context.pending_background_run_ids and (
                response.stop_reason == "end_turn"
                or (context.max_steps > 0 and context.step >= context.max_steps)
            ):
                pending_summaries = await self._wait_for_background(context)

            # Termination check — end_turn wins over everything if it hits
            if response.stop_reason == "end_turn":
                base = response.text or ""
                if pending_summaries:
                    base += "\n\n" + "\n".join(pending_summaries)
                context.result = base
                context.mark_success()

            # --- 终止检测（Claude Code 风格优先级链）---
            # 顺序：end_turn > token_budget > wall_clock > blocking_limit
            #        > max_budget_usd > repeated_error > max_steps
            # token/wall_clock 在 max_steps 之前检查，避免预算超了还要烧 wrap_up 调用

            # token_budget: 累计 token 已超限 → 直接终止，不做 wrap_up
            elif context.token_budget_exhausted():
                context.mark_interrupted("max_tokens_exceeded")

            # wall_clock: 累计时间已超限 → 直接终止
            elif context.wall_clock_exceeded():
                context.mark_interrupted("max_wall_clock_exceeded")

            # blocking_limit: 上下文即将溢出
            elif (
                response.usage is not None
                and context.is_at_blocking_limit(response.usage.context_pct)
            ):
                context.mark_interrupted(TerminationReason.BLOCKING_LIMIT)

            # max_budget_usd: USD 成本上限
            elif context.is_over_budget():
                context.mark_interrupted(TerminationReason.MAX_BUDGET_USD)

            # repeated_error: 同一工具同类错误连续 N 次
            elif context.error_accumulator and any(
                count >= 3
                for tool_errors in context.error_accumulator.values()
                for count in tool_errors.values()
            ):
                context.mark_failed(TerminationReason.REPEATED_ERROR)

            elif context.max_steps > 0 and context.step >= context.max_steps:
                # 结语宽限步：最后一步工具全部成功时，追加一步无工具回合让模型正常收尾。
                # 模型给出完成标记即记为 success；否则保留文本并按步数耗尽标记 interrupted
                if (
                    self._grace_step_on_max_steps
                    and not context.token_budget_exhausted()
                    and response.stop_reason == "tool_use"
                    and not has_errors
                ):
                    concluded, conclusion_text = await self._conclude(
                        context, pending_summaries
                    )
                    if concluded:
                        context.result = conclusion_text
                        context.mark_success()
                    else:
                        context.result = conclusion_text or context.result
                        context.mark_interrupted("exceeded_max_steps")
                else:
                    # 收尾回合：步数到限且预算未耗尽时给一次总结，避免裸失败
                    if self._wrap_up_on_max_steps and not context.token_budget_exhausted():
                        summary = await self._wrap_up(context, pending_summaries)
                        context.result = summary or (
                            "\n".join(pending_summaries) if pending_summaries else ""
                        )
                    elif pending_summaries:
                        context.result = "\n".join(pending_summaries)
                    context.mark_interrupted("exceeded_max_steps")

            # Claude Code 风格继续原因追踪
            if not context.is_done() and response.stop_reason == "tool_use":
                context.last_continue_reason = ContinueReason.NEXT_TURN
            elif not context.is_done() and response.stop_reason == "max_tokens":
                if context.max_output_tokens_recovery_count < 3:
                    context.max_output_tokens_recovery_count += 1
                    context.last_continue_reason = ContinueReason.MAX_OUTPUT_TOKENS_RECOVERY
                else:
                    context.messages.append({
                        "role": "user",
                        "content": (
                            "You have hit the output token limit multiple times. "
                            "Please provide a concise final answer now."
                        ),
                    })
                    context.last_continue_reason = ContinueReason.NEXT_TURN

            # 工具结果追加完毕（messages 末尾为 user）后检查压缩，仅在 run 继续时触发
            # 此时压缩结果 [user_summary, assistant_ack] 对下一次 LLM 调用是合法输入
            # 多条件触发（Claude Code 风格）：context_pct OR 累计 tokens OR 步数 OR turn 数
            if (
                not context.is_done()
                and response.stop_reason != "end_turn"
                and self._compactor is not None
                and response.usage is not None
            ):
                should_compact = False
                # 条件 A: context_pct 超过百分比阈值
                if self._compact_threshold > 0:
                    trigger_pct = response.usage.context_pct
                    if response.usage.input_tokens > 0 and added_estimate:
                        trigger_pct = (
                            response.usage.context_pct
                            * (response.usage.input_tokens + added_estimate)
                            / response.usage.input_tokens
                        )
                    if trigger_pct >= self._compact_threshold:
                        should_compact = True
                # 条件 B: 累计 input tokens 超过绝对值阈值
                if (
                    not should_compact
                    and self._auto_compact_min_tokens > 0
                    and context.total_input_tokens >= self._auto_compact_min_tokens
                ):
                    should_compact = True
                # 条件 C: 步数超过阈值
                if (
                    not should_compact
                    and self._auto_compact_min_steps > 0
                    and context.step >= self._auto_compact_min_steps
                ):
                    should_compact = True
                # 条件 D: 滑动窗口 — turn 数超过窗口 + 缓冲
                if (
                    not should_compact
                    and self._sliding_window_size > 0
                ):
                    from sztu_code.core.compact.compactor import _split_into_turns
                    turns = _split_into_turns(context.messages)
                    body_turns = turns[1:] if turns else []
                    if len(body_turns) > self._sliding_window_size + 2:
                        should_compact = True
                if should_compact:
                    # 熔断器检查：连续压缩失败超阈值则禁用自动压缩
                    if (
                        self._circuit_breaker_max_failures > 0
                        and context.compaction_failure_count >= self._circuit_breaker_max_failures
                    ):
                        if not self._circuit_breaker_logged:
                            log.warning(
                                "compaction circuit breaker tripped failures=%d session=%s — "
                                "auto-compaction disabled for this run",
                                context.compaction_failure_count, self._session_id,
                            )
                            self._circuit_breaker_logged = True
                        should_compact = False
                    # 压缩冷却期：两次压缩至少间隔 N 步，防止压缩→失忆→重读→触发压缩死循环
                    elif self._compact_cooldown_steps > 0 and (
                        context.step - self._last_compact_step < self._compact_cooldown_steps
                    ):
                        should_compact = False
                    else:
                        # 滑动窗口异步压缩 — 不阻塞 Agent 继续处理下一步
                        self._compactor.compact_async(
                            context, self._provider,
                            sliding_window_size=self._sliding_window_size,
                        )
                        self._last_compact_step = context.step

            await self._bus.publish(
                StepFinishedEvent(run_id=context.run_id, step=context.step, ts=_now())
            )

    # 收尾回合：max_steps 到达且预算未耗尽时，做一次无工具 LLM 调用，
    # 让模型总结进度/状态/剩余工作，写入 context.result 后再标记失败
    async def _wrap_up(
        self, context: ExecutionContext, pending_summaries: list[str]
    ) -> str:
        instruction = (
            "The agent run has reached its step limit and must stop now. "
            "Provide a concise summary covering: (1) progress made so far, "
            "(2) the current system/file state, and (3) remaining work, "
            "so the task can be resumed or handed off later. Do not call any tools."
        )
        if pending_summaries:
            instruction += "\n\nBackground subagent results:\n" + "\n".join(pending_summaries)
        context.messages.append({"role": "user", "content": instruction})
        try:
            response = await self._provider.chat(
                messages=truncate_tool_results(
                    context.messages,
                    limit=self._tool_result_limit,
                    keep=self._tool_result_keep,
                ),
                tool_schemas=[],
                bus=self._bus,
                run_id=context.run_id,
                step=context.step,
                system=context.system_prompt(
                    context.base_system_prompt or _DEFAULT_SYSTEM_PROMPT
                ),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).exception(
                "wrap-up LLM call failed run_id=%s step=%d",
                context.run_id, context.step,
            )
            return ""
        if response.usage is not None:
            context.total_input_tokens += response.usage.input_tokens
            context.total_output_tokens += response.usage.output_tokens
        summary = (response.text or "").strip()
        # 保持消息配对：无论有无文本都追加 assistant 消息
        context.messages.append(
            {"role": "assistant", "content": [{"type": "text", "text": summary}]}
        )
        return summary

    # 结语宽限步：max_steps 边界且最后一步工具成功时，做一次无工具 LLM 调用，
    # 让模型给出最终答复；返回 (是否明确完成, 最终文本)
    async def _conclude(
        self, context: ExecutionContext, pending_summaries: list[str]
    ) -> tuple[bool, str]:
        instruction = (
            "The agent run has reached its step limit and must stop now. "
            "Give your final answer. If the goal is fully achieved, start your "
            "response with the exact marker [COMPLETE] and state the result. "
            "If there is still work left, start with the exact marker [INCOMPLETE] "
            "and list what remains. Do not call any tools."
        )
        if pending_summaries:
            instruction += "\n\nBackground subagent results:\n" + "\n".join(pending_summaries)
        context.messages.append({"role": "user", "content": instruction})
        try:
            response = await self._provider.chat(
                messages=truncate_tool_results(
                    context.messages,
                    limit=self._tool_result_limit,
                    keep=self._tool_result_keep,
                ),
                tool_schemas=[],
                bus=self._bus,
                run_id=context.run_id,
                step=context.step,
                system=context.system_prompt(
                    context.base_system_prompt or _DEFAULT_SYSTEM_PROMPT
                ),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).exception(
                "conclude LLM call failed run_id=%s step=%d",
                context.run_id, context.step,
            )
            return (False, "")
        if response.usage is not None:
            context.total_input_tokens += response.usage.input_tokens
            context.total_output_tokens += response.usage.output_tokens
        text = (response.text or "").strip()
        # 保持消息配对：无论有无文本都追加 assistant 消息
        context.messages.append(
            {"role": "assistant", "content": [{"type": "text", "text": text}]}
        )
        if response.stop_reason != "end_turn":
            return (False, text)
        lowered = text.lower()
        if lowered.startswith("[incomplete]"):
            return (False, text)
        if lowered.startswith("[complete]"):
            stripped = text[len("[COMPLETE]"):].strip()
            return (True, stripped if stripped else text)
        # 未按标记作答但正常 end_turn：与普通回合一致，信任为完成
        return (True, text)

    # 等待本 run 派生的后台 subagent 全部结束，返回每条的结果摘要
    async def _wait_for_background(
        self, context: ExecutionContext
    ) -> list[str]:
        if self._task_registry is None or not context.pending_background_run_ids:
            return []
        run_ids = sorted(context.pending_background_run_ids)
        context.pending_background_run_ids.clear()
        entries = [self._task_registry.get(rid) for rid in run_ids]
        tasks = [e[0] for e in entries if e is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        summaries: list[str] = []
        for rid, entry in zip(run_ids, entries):
            if entry is None:
                summaries.append(f"[subagent {rid}] status=unknown")
                continue
            task, child_ctx = entry
            if task.cancelled():
                summaries.append(f"[subagent {rid}] status=cancelled")
            elif task.exception() is not None:
                summaries.append(f"[subagent {rid}] status=error: {task.exception()!r}")
            else:
                text = (child_ctx.result or "").strip()[:200]
                summaries.append(f"[subagent {rid}] status={child_ctx.status}: {text}")
        return summaries
