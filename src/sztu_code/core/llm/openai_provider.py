from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import httpx
import openai
from openai import AsyncOpenAI

from sztu_code.core.bus.events import (
    LlmModelSelectedEvent,
    LlmThinkingEvent,
    LlmTokenEvent,
    LlmUsageEvent,
)
from sztu_code.core.events.bus import EventBus
from sztu_code.core.llm.types import LlmResponse, ToolCallBlock, UsageStats

_DEFAULT_CONTEXT_WINDOW = 128_000

_KNOWN_CONTEXT_WINDOWS: list[tuple[str, int]] = [
    ("deepseek-v4-", 1_000_000),
    ("gpt-4.1-mini", 1_000_000),
    ("gpt-4.1-nano", 1_000_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-4o", 128_000),
    ("gpt-4", 128_000),
    ("o1", 200_000),
    ("o3", 200_000),
    ("deepseek-reasoner", 64_000),
    ("deepseek-chat", 64_000),
]

_MAX_STREAM_RETRIES = 3
_RETRY_BACKOFF_S = (1.0, 2.0, 4.0)
# 限流/服务过载（429/503/5xx）用更长的退避
_RATE_LIMIT_BACKOFF_S = (5.0, 10.0, 20.0)

log = logging.getLogger(__name__)


# Return the context window used for usage display and compaction thresholds.
def _context_window(model: str, override: int = 0) -> int:
    if override > 0:
        return override
    normalized = model.lower()
    for prefix, window in _KNOWN_CONTEXT_WINDOWS:
        if normalized.startswith(prefix):
            return window
    return _DEFAULT_CONTEXT_WINDOW


_SYSTEM_PROMPT = (
    "You are a helpful AI assistant. "
    "Use the available tools to complete the user's goal. "
    "When the goal is fully achieved, respond with a final answer and do not call any more tools."
)


# 返回当前 UTC 时间的 ISO 8601 字符串
def _now() -> str:
    return datetime.now(UTC).isoformat()


# 将 Anthropic 格式的 messages 转换为 OpenAI messages 列表，system prompt 单独返回
def _anth_to_openai_messages(
    messages: list[dict[str, object]],
    system: str | None = None,
    *,
    text_tool_history: bool = False,
    cache_control: bool = False,
) -> list[dict[str, object]]:
    openai_msgs: list[dict[str, object]] = []
    tool_names: dict[str, str] = {}

    # system prompt 作为第一条消息；启用时打 cache 断点标记稳定前缀
    effective_system = system or _SYSTEM_PROMPT
    system_msg: dict[str, object] = {"role": "system", "content": effective_system}
    if cache_control:
        system_msg["cache_control"] = {"type": "ephemeral"}
    openai_msgs.append(system_msg)

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "user":
            if isinstance(content, str):
                openai_msgs.append({"role": "user", "content": content})
            elif isinstance(content, list):
                text_parts: list[str] = []
                image_parts: list[dict[str, object]] = []
                tool_msgs: list[dict[str, object]] = []
                for block in content:
                    btype = block.get("type", "")
                    if btype == "text":
                        text_parts.append(str(block.get("text", "")))
                    elif btype == "image":
                        # Anthropic image block → OpenAI image_url（data URL）
                        source = block.get("source", {})
                        if isinstance(source, dict):
                            media_type = str(source.get("media_type", ""))
                            data = str(source.get("data", ""))
                            if media_type and data:
                                image_parts.append(
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": f"data:{media_type};base64,{data}"
                                        },
                                    }
                                )
                    elif btype == "tool_result":
                        tc_id = str(block.get("tool_use_id", ""))
                        tc_content = str(block.get("content", ""))
                        if block.get("is_error"):
                            tc_content = "[ERROR] " + tc_content
                        if text_tool_history:
                            tool_name = tool_names.get(tc_id, tc_id or "unknown")
                            text_parts.append(f"[Tool result for {tool_name}]\n{tc_content}")
                        else:
                            tool_msgs.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": tc_id,
                                    "content": tc_content,
                                }
                            )
                if image_parts:
                    # OpenAI 多模态要求 content 为数组：text + image_url
                    user_content: list[dict[str, object]] = []
                    if text_parts:
                        user_content.append(
                            {"type": "text", "text": "\n".join(text_parts)}
                        )
                    user_content.extend(image_parts)
                    openai_msgs.append({"role": "user", "content": user_content})
                elif text_parts:
                    openai_msgs.append({"role": "user", "content": "\n".join(text_parts)})
                openai_msgs.extend(tool_msgs)

        elif role == "assistant":
            if isinstance(content, str):
                openai_msgs.append({"role": "assistant", "content": content})
            elif isinstance(content, list):
                assistant_text: list[str] = []
                reasoning_parts: list[str] = []
                tool_calls: list[dict[str, object]] = []
                for block in content:
                    btype = block.get("type", "")
                    if btype == "text":
                        assistant_text.append(str(block.get("text", "")))
                    elif btype == "thinking":
                        # DeepSeek 推理模型要求把 reasoning_content 原样传回
                        thinking = str(block.get("thinking", ""))
                        if thinking:
                            reasoning_parts.append(thinking)
                    elif btype == "tool_use":
                            inp_json = json.dumps(block.get("input", {}), ensure_ascii=False)
                            tool_id = str(block.get("id", ""))
                            tool_name = str(block.get("name", ""))
                            tool_names[tool_id] = tool_name
                            if text_tool_history:
                                assistant_text.append(
                                    f"[Tool call] {tool_name}({inp_json})"
                                )
                                continue
                            tool_calls.append(
                                {
                                    "id": tool_id,
                                    "type": "function",
                                    "function": {
                                        "name": tool_name,
                                        "arguments": inp_json,
                                    },
                                }
                            )
                assistant_msg: dict[str, object] = {"role": "assistant"}
                if assistant_text:
                    assistant_msg["content"] = "\n".join(assistant_text)
                else:
                    assistant_msg["content"] = None
                if reasoning_parts:
                    assistant_msg["reasoning_content"] = "".join(reasoning_parts)
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls
                openai_msgs.append(assistant_msg)

    return openai_msgs


# 将 Anthropic 格式的 tool_schemas 转换为 OpenAI tools 格式
def _anth_to_openai_tools(
    tool_schemas: list[dict[str, object]],
    *,
    cache_control: bool = False,
) -> list[dict[str, object]]:
    tools: list[dict[str, object]] = []
    for ts in tool_schemas:
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": ts.get("name", ""),
                    "description": ts.get("description", ""),
                    "parameters": ts.get("input_schema", {"type": "object", "properties": {}}),
                },
            }
        )
    # 在最后一个 tool 上打 cache 断点，使工具定义作为稳定前缀被缓存
    if cache_control and tools:
        last = dict(tools[-1])
        last["cache_control"] = {"type": "ephemeral"}
        tools = tools[:-1] + [last]
    return tools


# 将 OpenAI finish_reason 映射为 Anthropic stop_reason
def _map_finish_reason(finish_reason: str | None) -> str:
    if finish_reason == "tool_calls":
        return "tool_use"
    elif finish_reason == "length":
        return "max_tokens"
    elif finish_reason == "stop":
        return "end_turn"
    elif finish_reason == "content_filter":
        return "end_turn"
    return "end_turn"


# 去掉 Authorization 头的 httpx transport，用于免 key 的 OpenAI 兼容端点（如 opencode Zen 免费模型）
class _StripAuthTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncHTTPTransport) -> None:
        self._inner = inner

    # 发送请求前移除 Authorization 头，其余原样转发
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request.headers.pop("Authorization", None)
        return await self._inner.handle_async_request(request)


# 构建免 key 模式使用的 httpx 客户端（内部用去 auth 的 transport）
def _keyless_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=_StripAuthTransport(httpx.AsyncHTTPTransport()))


class OpenAIProvider:
    # 初始化 OpenAI 客户端；client 可在测试时注入以跳过 API key 检查
    def __init__(
        self,
        model: str,
        client: Any = None,
        *,
        context_window: int = 0,
        cache_control: bool = True,
    ) -> None:
        base_url = os.environ.get("OPENAI_BASE_URL")
        is_campus_deepseek = bool(
            model == "deepseek-v4-pro"
            and base_url
            and "apiai.sztu.edu.cn" in base_url.lower()
        )
        if client is None:
            api_key = os.environ.get("OPENAI_API_KEY") or ""
            if not api_key and not base_url:
                raise SystemExit("OPENAI_API_KEY not set (或设置 OPENAI_BASE_URL 使用免 key 端点)")
            client_kwargs: dict[str, Any] = {"api_key": api_key or "keyless-placeholder"}
            if base_url:
                client_kwargs["base_url"] = base_url
            client_kwargs["http_client"] = httpx.AsyncClient(trust_env=False)
            if not api_key:
                # 免 key 端点：SDK 需要非空 key，但用自定义 transport 剥掉 Authorization 头
                client_kwargs["http_client"] = _keyless_http_client()
            self._client: Any = AsyncOpenAI(**client_kwargs)
        else:
            self._client = client
        self._model = model
        self._text_tool_history = is_campus_deepseek
        self._context_window_override = context_window
        self._cache_control = cache_control

    # 流式调用 OpenAI 兼容 API，逐 token 发布事件并返回 LlmResponse；网络中断时自动重试
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
        await bus.publish(
            LlmModelSelectedEvent(run_id=run_id, model=self._model, strategy="static", ts=_now())
        )

        openai_msgs = _anth_to_openai_messages(
            messages,
            system=system,
            text_tool_history=self._text_tool_history,
            cache_control=self._cache_control,
        )
        tools = (
            _anth_to_openai_tools(tool_schemas, cache_control=self._cache_control)
            if tool_schemas else None
        )

        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_call_accum: dict[int, dict[str, object]] = {}
        final_finish_reason: str | None = None
        final_usage: Any = None

        for attempt in range(1, _MAX_STREAM_RETRIES + 1):
            text_parts = []
            thinking_parts = []
            tool_call_accum = {}
            final_finish_reason = None
            final_usage = None

            try:
                kwargs: dict[str, object] = {
                    "model": self._model,
                    "messages": openai_msgs,
                    "stream": True,
                }
                if tools:
                    kwargs["tools"] = tools

                stream = await self._client.chat.completions.create(**kwargs)
                async for chunk in stream:
                    if chunk.usage is not None:
                        final_usage = chunk.usage

                    if not chunk.choices:
                        continue

                    choice = chunk.choices[0]
                    delta = choice.delta

                    if delta is None:
                        continue

                    # DeepSeek reasoner 的推理内容
                    reasoning: str | None = getattr(delta, "reasoning_content", None)
                    if reasoning:
                        thinking_parts.append(reasoning)
                        if attempt == 1:
                            await bus.publish(
                                LlmThinkingEvent(
                                    run_id=run_id,
                                    step=step,
                                    thinking=reasoning,
                                    ts=_now(),
                                )
                            )
                        continue

                    # 普通文本内容
                    if delta.content:
                        if attempt == 1:
                            await bus.publish(
                                LlmTokenEvent(run_id=run_id, token=delta.content, ts=_now())
                            )
                        text_parts.append(delta.content)

                    # 工具调用增量
                    if delta.tool_calls:
                        for tc_delta in delta.tool_calls:
                            idx = tc_delta.index
                            if idx not in tool_call_accum:
                                tool_call_accum[idx] = {
                                    "id": "",
                                    "name": "",
                                    "arguments": "",
                                }
                            acc = tool_call_accum[idx]
                            if tc_delta.id:
                                acc["id"] = tc_delta.id
                            if tc_delta.function:
                                if tc_delta.function.name:
                                    acc["name"] = tc_delta.function.name
                                if tc_delta.function.arguments:
                                    acc["arguments"] += tc_delta.function.arguments

                    if choice.finish_reason is not None:
                        final_finish_reason = choice.finish_reason

                break  # success

            except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError) as exc:
                if attempt == _MAX_STREAM_RETRIES:
                    log.error(
                        "stream failed after %d attempts run_id=%s step=%d: %s",
                        _MAX_STREAM_RETRIES, run_id, step, exc,
                    )
                    raise
                delay = _RETRY_BACKOFF_S[attempt - 1]
                log.warning(
                    "stream dropped (attempt %d/%d) run_id=%s step=%d: %s — retrying in %.0fs",
                    attempt, _MAX_STREAM_RETRIES, run_id, step, exc, delay,
                )
                await asyncio.sleep(delay)
            except openai.APIError as exc:
                # 免费档限流/过载（429/503/5xx）带更长退避重试；其余 API 错误（401 等）直接抛
                status = getattr(exc, "status_code", None)
                if not (status in (429, 503) or (status and status >= 500)):
                    raise
                if attempt == _MAX_STREAM_RETRIES:
                    raise
                delay = _RATE_LIMIT_BACKOFF_S[attempt - 1]
                log.warning(
                    "LLM transient API error status=%s (attempt %d/%d) %s — retry in %.0fs",
                    status, attempt, _MAX_STREAM_RETRIES, run_id, delay,
                )
                await asyncio.sleep(delay)

        # 构建 usage 统计
        input_tokens = 0
        output_tokens = 0
        cache_read = 0
        if final_usage is not None:
            input_tokens = getattr(final_usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(final_usage, "completion_tokens", 0) or 0
            prompt_details = getattr(final_usage, "prompt_tokens_details", None)
            if prompt_details is not None:
                cache_read = getattr(prompt_details, "cached_tokens", 0) or 0

        context_pct = (
            input_tokens / _context_window(self._model, self._context_window_override)
            if input_tokens > 0
            else 0.0
        )

        await bus.publish(
            LlmUsageEvent(
                run_id=run_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=0,
                context_pct=context_pct,
                model=self._model,
                ts=_now(),
            )
        )

        # 解析工具调用
        tool_calls: list[ToolCallBlock] = []
        for idx in sorted(tool_call_accum.keys()):
            acc = tool_call_accum[idx]
            try:
                args_str = str(acc["arguments"])
                inp = json.loads(args_str) if args_str else {}
            except json.JSONDecodeError:
                inp = {}
            tool_calls.append(
                ToolCallBlock(
                    id=str(acc["id"]),
                    name=str(acc["name"]),
                    input=inp,
                )
            )

        # 构建 thinking blocks（DeepSeek reasoner）
        thinking_blocks: list[dict[str, object]] = []
        if thinking_parts:
            thinking_text = "".join(thinking_parts)
            thinking_blocks.append(
                {"type": "thinking", "thinking": thinking_text, "signature": ""}
            )

        stop_reason = _map_finish_reason(final_finish_reason)

        return LlmResponse(
            stop_reason=stop_reason,
            tool_calls=tool_calls,
            text="".join(text_parts),
            thinking_blocks=thinking_blocks,
            usage=UsageStats(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=0,
                context_pct=context_pct,
            ),
        )
