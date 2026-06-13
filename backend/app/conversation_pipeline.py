from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.util import find_spec
from typing import Any

from .ai import estimate_tokens, sentence_chunks, stream_llm
from .models import SessionState


@dataclass(frozen=True)
class PipelineEvent:
    type: str
    payload: dict[str, Any]


def pipecat_runtime_status() -> dict[str, Any]:
    """Report whether the installed runtime can use native Pipecat APIs.

    The current project keeps the wire protocol stable and runs on Python 3.9
    through this adapter. Native Pipecat imports require Python 3.10+ because
    recent Pipecat modules use modern type syntax.
    """

    installed = find_spec("pipecat") is not None
    python_ok = sys.version_info >= (3, 10)
    return {
        "installed": installed,
        "nativeAvailable": installed and python_ok,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "mode": "pipecat-native" if installed and python_ok else "pipecat-compatible-adapter",
    }


class ConversationPipeline:
    """Pipecat-compatible conversation pipeline for one WebSocket session.

    This class is the single place that owns turn generation, text streaming,
    TTS chunking, assistant history updates, and cancellation. Gateway code
    treats it like a transport adapter: it pushes final user turns in and sends
    the emitted events back over the existing WebSocket protocol.
    """

    def __init__(self, session: SessionState) -> None:
        self.session = session

    async def run_user_turn(self, user_text: str) -> AsyncIterator[PipelineEvent]:
        answer = ""
        tts_buffer = ""

        async for delta in stream_llm(self.session, user_text):
            answer += delta
            tts_buffer += delta
            self.session.cost.llm_output_tokens_est += estimate_tokens(delta)
            yield PipelineEvent("llm.delta", {"delta": delta})

            chunks, tts_buffer = sentence_chunks(tts_buffer)
            for chunk in chunks:
                self.session.cost.tts_chars += len(chunk)
                yield PipelineEvent("tts.audio.chunk", {"mode": "browser-speech", "text": chunk})
                yield PipelineEvent("session.cost", {"cost": self.session.cost.snapshot()})

        tail = tts_buffer.strip()
        if tail:
            self.session.cost.tts_chars += len(tail)
            yield PipelineEvent("tts.audio.chunk", {"mode": "browser-speech", "text": tail})

        if answer.strip():
            self.session.history.append({"role": "assistant", "content": answer.strip()})
        yield PipelineEvent("llm.done", {"cancelled": False})
        yield PipelineEvent("session.cost", {"cost": self.session.cost.snapshot()})

    async def cancel_pending_work(self, task: asyncio.Task[None] | None) -> None:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
