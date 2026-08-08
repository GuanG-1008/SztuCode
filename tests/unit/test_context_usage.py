from sztu_code.core.compact.context_usage import estimate_context_usage


def test_context_usage_categories_reconcile_to_provider_input() -> None:
    usage = estimate_context_usage(
        messages=[
            {"role": "user", "content": "This session is being continued from a previous conversation.\nSummary:\nDone."},
            {"role": "assistant", "content": [{"type": "text", "text": "Working"}, {"type": "tool_use", "name": "read", "input": {"path": "a.py"}}]},
            {"role": "user", "content": [{"type": "tool_result", "content": "file body"}]},
        ],
        tool_schemas=[{"name": "read", "description": "Read a file"}],
        system="You are an agent.",
        actual_input_tokens=1200,
        context_window=4000,
        reserved_output_tokens=500,
    )

    categorized = usage.system_tokens + usage.summary_tokens + usage.conversation_tokens + usage.tool_tokens
    assert categorized == 1200
    assert usage.summary_tokens > 0
    assert usage.tool_tokens > 0
    assert usage.reserved_output_tokens == 500
    assert usage.available_tokens == 2300


def test_context_usage_never_reports_negative_available_capacity() -> None:
    usage = estimate_context_usage(
        messages=[{"role": "user", "content": "hello"}],
        tool_schemas=[],
        system="system",
        actual_input_tokens=990,
        context_window=1000,
        reserved_output_tokens=200,
    )
    assert usage.reserved_output_tokens == 10
    assert usage.available_tokens == 0
