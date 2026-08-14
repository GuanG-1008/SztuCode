from __future__ import annotations

import asyncio
import json
from pathlib import Path

from sztu_code.core.config import SztuConfig
from sztu_code.core.events.bus import EventBus
from sztu_code.core.llm.types import LlmResponse, ToolCallBlock, UsageStats
from sztu_code.core.runner import AgentRunner
from sztu_code.core.session.model import Session
from sztu_code.core.session.store import SessionStore


class _LongCompactionProvider:
    def __init__(self) -> None:
        self._calls = 0
        self.compact_started = asyncio.Event()
        self.compact_completed = asyncio.Event()
        self._allow_compact = asyncio.Event()
        self._summary = """\
## 1. Original Goal
persist compaction before returning
## 2. Completed Steps
- background compaction finished
## 3. Key Constraints & Discoveries
- runner must not finish first
## 4. Current File State
- thread.jsonl now starts with summary
## 5. Remaining TODOs
- none
## 6. Critical Data
- stable summary
"""

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
        if run_id == "compact":
            self.compact_started.set()
            await self._allow_compact.wait()
            await asyncio.sleep(0.05)
            self.compact_completed.set()
            return LlmResponse(
                stop_reason="end_turn",
                text=self._summary,
                usage=UsageStats(input_tokens=100_000, output_tokens=10),
            )

        self._calls += 1
        if self._calls == 1:
            return LlmResponse(
                stop_reason="tool_use",
                tool_calls=[ToolCallBlock(id="t1", name="unknown_tool", input={})],
                usage=UsageStats(
                    input_tokens=100_000,
                    output_tokens=10,
                    context_pct=0.9,
                ),
            )

        self._allow_compact.set()
        return LlmResponse(
            stop_reason="end_turn",
            text="done",
            usage=UsageStats(input_tokens=200, output_tokens=10),
        )


def _event_types(path: Path) -> list[str]:
    return [
        json.loads(line)["type"]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


async def test_run_outcome_returns_after_long_compaction_is_persisted(tmp_path: Path) -> None:
    cfg = SztuConfig()
    cfg.compaction.auto_threshold = 0.8
    store = SessionStore(tmp_path / "sessions")
    session = Session(
        id="sess-1",
        mode="chat",
        status="active",
        title="",
        created_at="t",
        updated_at="t",
    )
    store.write_meta(session)
    store.append_message("sess-1", "user", "old goal")
    store.append_message("sess-1", "assistant", "working")
    store.append_message("sess-1", "user", "new goal with enough history")

    provider = _LongCompactionProvider()
    runner = AgentRunner(
        cfg,
        provider=provider,  # type: ignore[arg-type]
        runs_dir=tmp_path / "runs",
    )

    outcome = await runner.run_and_capture(
        "new goal",
        run_id="run-long-compact",
        session=session,
        store=store,
    )

    assert outcome.status == "success"
    assert provider.compact_started.is_set()
    assert provider.compact_completed.is_set()
    messages = store.read_messages("sess-1")
    assert "Original Goal" in messages[0]["content"]
    summary_files = list(store.session_dir("sess-1").glob("summary_*.md"))
    assert len(summary_files) == 1
    event_types = _event_types(store.runs_dir("sess-1") / "run-long-compact" / "events.jsonl")
    assert "context.compacted" in event_types
    assert event_types.index("context.compacted") < event_types.index("run.finished")
    assert event_types[-1] == "run.finished"
