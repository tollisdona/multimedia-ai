from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from importlib.util import find_spec
from typing import Any

from .agent_runtime import AgentContext, AgentRouter, AgentSpec, EmitEvent, PipelineEvent, RequestFrame
from .ai import estimate_tokens, sentence_chunks, stream_direct_model
from .medication_agent import MedicationInstructionAgent
from .medication_intent import MEDICATION_AGENT, detect_medication_intent
from .medication_ocr import QwenVlDocumentOcrProvider
from .models import SessionState


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

    def __init__(
        self,
        session: SessionState,
        emit: EmitEvent | None = None,
        request_frame: RequestFrame | None = None,
        ocr_provider: Any | None = None,
    ) -> None:
        self.session = session
        self.emit = emit
        self.request_frame = request_frame
        self.ocr_provider = ocr_provider or QwenVlDocumentOcrProvider(session)
        self.router = AgentRouter(
            [
                AgentSpec(
                    name=MEDICATION_AGENT,
                    runner_factory=lambda context: MedicationInstructionAgent(context),
                )
            ]
        )

    async def run_user_turn(self, user_text: str) -> AsyncIterator[PipelineEvent]:
        medication_context_active = self.session.agent_state == "medication.ready_for_followup"
        medication_intent = detect_medication_intent(user_text, active_context=medication_context_active)
        if medication_intent.should_exit:
            self.clear_agent_state()
            yield PipelineEvent("agent.exited", {"agent": MEDICATION_AGENT, "reason": "user_exit"})
        elif medication_intent.matched:
            spec = self.router.by_name(MEDICATION_AGENT)
            if spec:
                context = AgentContext(
                    session=self.session,
                    emit=self.emit,
                    request_frame=self.request_frame,
                    ocr_provider=self.ocr_provider,
                )
                runner = spec.runner_factory(context)
                async for event in runner.run(user_text):
                    yield event
                return
        elif medication_context_active:
            self.clear_agent_state()
            yield PipelineEvent("agent.exited", {"agent": MEDICATION_AGENT, "reason": "topic_changed"})

        async for event in self.run_general_turn(user_text):
            yield event

    async def run_general_turn(self, user_text: str) -> AsyncIterator[PipelineEvent]:
        answer = ""
        tts_buffer = ""

        async for delta in stream_direct_model(self.session, user_text):
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

    def clear_agent_state(self) -> None:
        self.session.active_agent = ""
        self.session.agent_state = "idle"
        self.session.agent_context = {}
        self.session.agent_followup_until = 0
        self.session.agent_turns_remaining = 0

    async def cancel_pending_work(self, task: asyncio.Task[None] | None) -> None:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
