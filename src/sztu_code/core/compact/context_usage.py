from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sztu_code.core.compact.token_counter import TokenCounter


@dataclass(frozen=True)
class ContextUsageBreakdown:
    context_window: int
    available_tokens: int
    reserved_output_tokens: int
    system_tokens: int
    summary_tokens: int
    conversation_tokens: int
    tool_tokens: int


def _count(counter: TokenCounter, value: Any) -> int:
    if value in (None, "", [], {}):
        return 0
    if isinstance(value, str):
        return counter.count(value)
    return counter.count(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _is_summary_message(message: dict[str, object]) -> bool:
    content = message.get("content")
    if isinstance(content, str):
        return "This session is being continued" in content and "Summary:" in content
    if isinstance(content, list):
        return any(
            isinstance(block, dict)
            and "continue from this summary" in str(block.get("text", "")).lower()
            for block in content
        )
    return False


def estimate_context_usage(
    *,
    messages: list[dict[str, object]],
    tool_schemas: list[dict[str, object]],
    system: str,
    actual_input_tokens: int,
    context_window: int,
    reserved_output_tokens: int,
) -> ContextUsageBreakdown:
    """Estimate explainable context categories and reconcile them to provider usage."""
    counter = TokenCounter()
    raw = {
        "system": _count(counter, system),
        "summary": 0,
        "conversation": 0,
        "tools": _count(counter, tool_schemas),
    }
    for message in messages:
        if _is_summary_message(message):
            raw["summary"] += _count(counter, message)
            continue
        content = message.get("content")
        if isinstance(content, list):
            tool_blocks = [
                block
                for block in content
                if isinstance(block, dict) and block.get("type") in {"tool_use", "tool_result"}
            ]
            raw["tools"] += _count(counter, tool_blocks)
            raw["conversation"] += _count(
                counter, [block for block in content if block not in tool_blocks]
            )
        else:
            raw["conversation"] += _count(counter, content)
    estimated_total = sum(raw.values())
    scale = (
        actual_input_tokens / estimated_total
        if actual_input_tokens > 0 and estimated_total > 0
        else 1.0
    )
    values = {key: max(0, round(value * scale)) for key, value in raw.items()}
    values["conversation"] = max(
        0, values["conversation"] + actual_input_tokens - sum(values.values())
    )
    reserved = min(
        max(0, reserved_output_tokens), max(0, context_window - actual_input_tokens)
    )
    return ContextUsageBreakdown(
        context_window,
        max(0, context_window - actual_input_tokens - reserved),
        reserved,
        values["system"],
        values["summary"],
        values["conversation"],
        values["tools"],
    )
